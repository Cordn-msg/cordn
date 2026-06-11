import type {
  FetchManyGroupMessagesInput,
  FetchManyPendingJoinRequestsInput,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  JoinRequestRecord,
  PostGroupMessageInput,
  PublishedKeyPackageRecord,
  PublishKeyPackageInput,
  StoreJoinRequestInput,
  SubscribeGroupMessagesInput,
  SubscribeManyGroupMessagesInput,
  StoreWelcomeInput,
  WelcomeQueueRecord,
} from "./types.ts";
import type { CoordinatorStorage } from "./storage/storage.ts";
import { InMemoryCoordinatorStorage } from "./storage/inMemoryStorage.ts";
import { isLastResortKeyPackage } from "../lastResortKeyPackage.ts";

import {
  contentTypes,
  mlsMessageDecoder,
  wireformats,
  type MlsMessage,
} from "ts-mls";

const groupIdDecoder = new TextDecoder();

export interface CoordinatorOptions {
  storage?: CoordinatorStorage;
  now?: () => number;
  /** TTL in ms for read welcome and join request cleanup. Read records whose readAt is older than this threshold are deleted. Default: 1h. */
  welcomeTtlMs?: number;
  /** Interval in ms between cleanup runs. Set to 0 to disable. Default: 1h. */
  welcomeCleanupIntervalMs?: number;
  /** Max age in ms for unread welcome and join request records. Unread records created before (now - maxAge) are deleted. Set to 0 or negative to disable (keep unread forever). Default: 30 days (2_592_000_000). */
  welcomeMaxAgeMs?: number;
}

function decodeOpaqueMessage(opaqueMessage: Uint8Array): MlsMessage {
  const decoded = mlsMessageDecoder(opaqueMessage, 0);
  if (!decoded) {
    throw new Error("Unable to decode MLS message");
  }

  return decoded[0];
}

function getMessageMetadata(message: MlsMessage): {
  groupId: string;
  epoch: bigint;
  handshakeMessage: boolean;
} {
  switch (message.wireformat) {
    case wireformats.mls_private_message:
      return {
        groupId: groupIdDecoder.decode(message.privateMessage.groupId),
        epoch: message.privateMessage.epoch,
        handshakeMessage:
          message.privateMessage.contentType !== contentTypes.application,
      };
    case wireformats.mls_public_message:
      return {
        groupId: groupIdDecoder.decode(message.publicMessage.content.groupId),
        epoch: message.publicMessage.content.epoch,
        handshakeMessage:
          message.publicMessage.content.contentType !==
          contentTypes.application,
      };
    default:
      throw new Error(
        "Group delivery only accepts MLS private or public messages",
      );
  }
}

function resolveLatestHandshakeEpoch(
  currentRouting: GroupRoutingRecord | null,
  epoch: bigint,
  handshakeMessage: boolean,
): bigint {
  if (!handshakeMessage) {
    return currentRouting?.latestHandshakeEpoch ?? epoch;
  }

  return currentRouting && currentRouting.latestHandshakeEpoch > epoch
    ? currentRouting.latestHandshakeEpoch
    : epoch;
}

class AsyncMessageQueue implements AsyncIterable<GroupMessageRecord> {
  private readonly values: GroupMessageRecord[] = [];
  private nextValueIndex = 0;
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<GroupMessageRecord>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private aborted: unknown = null;
  private maxDepth = 0;

  push(value: GroupMessageRecord): void {
    if (this.closed || this.aborted) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }

    this.values.push(value);
    if (this.values.length > this.maxDepth) {
      this.maxDepth = this.values.length;
    }
  }

  getDepth(): number {
    return this.values.length - this.nextValueIndex;
  }

  getMaxDepth(): number {
    return this.maxDepth;
  }

  close(): void {
    if (this.closed || this.aborted) {
      return;
    }

    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  abort(error: unknown): void {
    if (this.aborted || this.closed) {
      return;
    }

    this.aborted = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<GroupMessageRecord> {
    return {
      next: async (): Promise<IteratorResult<GroupMessageRecord>> => {
        if (this.nextValueIndex < this.values.length) {
          const value = this.values[this.nextValueIndex]!;
          this.nextValueIndex += 1;

          if (
            this.nextValueIndex > 1024 &&
            this.nextValueIndex * 2 >= this.values.length
          ) {
            this.values.splice(0, this.nextValueIndex);
            this.nextValueIndex = 0;
          }

          return { value, done: false };
        }

        if (this.aborted) {
          throw this.aborted;
        }

        if (this.closed) {
          return { value: undefined, done: true };
        }

        return new Promise<IteratorResult<GroupMessageRecord>>(
          (resolve, reject) => {
            this.waiters.push({ resolve, reject });
          },
        );
      },
      return: async (): Promise<IteratorResult<GroupMessageRecord>> => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

interface GroupMessageSubscription {
  messages: AsyncIterable<GroupMessageRecord>;
  unsubscribe: () => void;
}

interface GroupMessageSubscriber {
  push(record: GroupMessageRecord): void;
  replay?(records: GroupMessageRecord[]): void;
  close(): void;
}

export class Coordinator {
  private readonly storage: CoordinatorStorage;
  private readonly now: () => number;
  private readonly groupSubscribers = new Map<
    string,
    Set<GroupMessageSubscriber>
  >();
  private readonly cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CoordinatorOptions = {}) {
    this.storage = options.storage ?? new InMemoryCoordinatorStorage();
    this.now = options.now ?? Date.now;

    const intervalMs = options.welcomeCleanupIntervalMs ?? 3_600_000;
    if (intervalMs > 0) {
      const ttlMs = options.welcomeTtlMs ?? 3_600_000;
      const maxAgeMs = options.welcomeMaxAgeMs ?? 2_592_000_000; // 30 days
      this.cleanupTimer = setInterval(() => {
        const now = this.now();
        const readThreshold = now - ttlMs;
        const unreadThreshold = maxAgeMs > 0 ? now - maxAgeMs : 0;
        this.deleteExpiredWelcomes(readThreshold, unreadThreshold);
        this.deleteExpiredJoinRequests(readThreshold, unreadThreshold);
      }, intervalMs);
      // Allow the timer to not keep the process alive.
      if (this.cleanupTimer && "unref" in this.cleanupTimer) {
        this.cleanupTimer.unref();
      }
    }
  }

  publishKeyPackage(input: PublishKeyPackageInput): PublishedKeyPackageRecord {
    const record: PublishedKeyPackageRecord = {
      stablePubkey: input.stablePubkey,
      keyPackage: input.keyPackage,
      keyPackageRef: input.keyPackageRef,
      isLastResort: isLastResortKeyPackage(input.keyPackage),
      publishedAt: this.now(),
      publicationEvent: input.publicationEvent,
    };

    return this.storage.publishKeyPackage(record);
  }

  listKeyPackagesForIdentity(
    stablePubkey: string,
  ): PublishedKeyPackageRecord[] {
    return this.storage.listKeyPackagesForIdentity(stablePubkey);
  }

  listAllKeyPackages(): PublishedKeyPackageRecord[] {
    return this.storage.listAllKeyPackages();
  }

  getKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    return this.storage.getKeyPackage(keyPackageRef);
  }

  removeKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    return this.storage.removeKeyPackage(keyPackageRef);
  }

  consumeKeyPackage(identifier: string): PublishedKeyPackageRecord | null {
    return this.storage.consumeKeyPackage(identifier);
  }

  storeWelcome(input: StoreWelcomeInput): WelcomeQueueRecord {
    const record: WelcomeQueueRecord = {
      targetStablePubkey: input.targetStablePubkey,
      keyPackageReference: input.keyPackageReference,
      welcome: input.welcome,
      createdAt: this.now(),
      readAt: null,
    };

    return this.storage.storeWelcome(record);
  }

  fetchPendingWelcomes(targetStablePubkey: string): WelcomeQueueRecord[] {
    return this.storage.fetchPendingWelcomes(targetStablePubkey, this.now());
  }

  deleteExpiredWelcomes(
    readThreshold: number,
    unreadThreshold: number,
  ): number {
    return this.storage.deleteExpiredWelcomes(readThreshold, unreadThreshold);
  }

  storeJoinRequest(input: StoreJoinRequestInput): JoinRequestRecord {
    const record: JoinRequestRecord = {
      groupId: input.groupId,
      requesterStablePubkey: input.requesterStablePubkey,
      keyPackageRef: input.keyPackageRef,
      createdAt: this.now(),
      readAt: null,
    };

    return this.storage.storeJoinRequest(record);
  }

  fetchPendingJoinRequests(groupId: string): JoinRequestRecord[] {
    return this.storage.fetchPendingJoinRequests(groupId, this.now());
  }

  fetchManyPendingJoinRequests(
    input: FetchManyPendingJoinRequestsInput,
  ): JoinRequestRecord[] {
    return this.storage.fetchManyPendingJoinRequests(input, this.now());
  }

  deleteExpiredJoinRequests(
    readThreshold: number,
    unreadThreshold: number,
  ): number {
    return this.storage.deleteExpiredJoinRequests(
      readThreshold,
      unreadThreshold,
    );
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  postGroupMessage(input: PostGroupMessageInput): GroupMessageRecord {
    const decodedMessage = decodeOpaqueMessage(input.opaqueMessage);
    const { groupId, epoch, handshakeMessage } =
      getMessageMetadata(decodedMessage);
    const currentRouting = this.storage.getGroupRouting(groupId);

    if (
      handshakeMessage &&
      currentRouting &&
      epoch < currentRouting.latestHandshakeEpoch
    ) {
      throw new Error(
        `Rejected stale handshake message for group ${groupId}: ${epoch} < ${currentRouting.latestHandshakeEpoch}`,
      );
    }

    const latestHandshakeEpoch = resolveLatestHandshakeEpoch(
      currentRouting,
      epoch,
      handshakeMessage,
    );

    const record = this.storage.appendGroupMessage({
      groupId,
      latestHandshakeEpoch,
      epoch,
      ephemeralSenderPubkey: input.ephemeralSenderPubkey,
      opaqueMessage: input.opaqueMessage,
      createdAt: this.now(),
    });

    this.publishLiveGroupMessage(record);

    return record;
  }

  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[] {
    return this.storage.fetchGroupMessages(input);
  }

  fetchManyGroupMessages(
    input: FetchManyGroupMessagesInput,
  ): GroupMessageRecord[] {
    return this.storage.fetchManyGroupMessages(input);
  }

  subscribeGroupMessages(
    input: SubscribeGroupMessagesInput,
  ): GroupMessageSubscription {
    const queue = new AsyncMessageQueue();
    const subscriber: GroupMessageSubscriber = queue;

    this.addGroupSubscriber(input.groupId, subscriber);

    return {
      messages: queue,
      unsubscribe: () => {
        subscriber.close();
        this.removeGroupSubscriber(input.groupId, subscriber);
      },
    };
  }

  subscribeManyGroupMessages(
    input: SubscribeManyGroupMessagesInput,
  ): GroupMessageSubscription {
    const queue = new AsyncMessageQueue();
    const cursorsByGroup = new Map<string, number>();
    const liveBuffer: GroupMessageRecord[] = [];
    let replayingBacklog = true;
    for (const group of input.groups) {
      cursorsByGroup.set(group.groupId, group.afterCursor ?? 0);
    }
    const groupIds = [...cursorsByGroup.keys()];
    const emitIfNew = (record: GroupMessageRecord): void => {
      const lastEmittedCursor = cursorsByGroup.get(record.groupId) ?? 0;
      if (record.cursor <= lastEmittedCursor) {
        return;
      }

      cursorsByGroup.set(record.groupId, record.cursor);
      queue.push(record);
    };
    const subscriber: GroupMessageSubscriber = {
      push: (record) => {
        if (replayingBacklog) {
          liveBuffer.push(record);
          return;
        }

        emitIfNew(record);
      },
      replay: (records) => {
        for (const record of records) {
          emitIfNew(record);
        }
      },
      close: () => queue.close(),
    };

    for (const groupId of groupIds) {
      this.addGroupSubscriber(groupId, subscriber);
    }

    const backlog = this.fetchManyGroupMessages(input);
    subscriber.replay?.(backlog);
    replayingBacklog = false;
    for (const record of liveBuffer.splice(0)) {
      subscriber.push(record);
    }

    return {
      messages: queue,
      unsubscribe: () => {
        subscriber.close();
        for (const groupId of groupIds) {
          this.removeGroupSubscriber(groupId, subscriber);
        }
      },
    };
  }

  private addGroupSubscriber(
    groupId: string,
    subscriber: GroupMessageSubscriber,
  ): void {
    let subscribers = this.groupSubscribers.get(groupId);
    if (!subscribers) {
      subscribers = new Set();
      this.groupSubscribers.set(groupId, subscribers);
    }

    subscribers.add(subscriber);
  }

  private removeGroupSubscriber(
    groupId: string,
    subscriber: GroupMessageSubscriber,
  ): void {
    const subscribers = this.groupSubscribers.get(groupId);
    if (!subscribers) {
      return;
    }

    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      this.groupSubscribers.delete(groupId);
    }
  }

  private publishLiveGroupMessage(record: GroupMessageRecord): void {
    const subscribers = this.groupSubscribers.get(record.groupId);
    if (!subscribers) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber.push(record);
    }
  }

  getGroupRouting(groupId: string): GroupRoutingRecord | null {
    return this.storage.getGroupRouting(groupId);
  }

  getActiveSubscriptionCount(): number {
    let count = 0;
    for (const subscribers of this.groupSubscribers.values()) {
      count += subscribers.size;
    }
    return count;
  }
}

export function createCoordinator(
  options: CoordinatorOptions = {},
): Coordinator {
  return new Coordinator(options);
}
