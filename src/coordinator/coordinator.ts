import type {
  DeliveryServiceSnapshot,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  PostGroupMessageInput,
  PublishedKeyPackageRecord,
  PublishKeyPackageInput,
  SubscribeGroupMessagesInput,
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
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<GroupMessageRecord>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private aborted: unknown = null;

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
        if (this.values.length > 0) {
          const value = this.values.shift();
          if (!value) {
            throw new Error("Queue invariant violated");
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

export class Coordinator {
  private readonly storage: CoordinatorStorage;
  private readonly now: () => number;
  private readonly groupSubscribers = new Map<string, Set<AsyncMessageQueue>>();

  constructor(options: CoordinatorOptions = {}) {
    this.storage = options.storage ?? new InMemoryCoordinatorStorage();
    this.now = options.now ?? Date.now;
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
    };

    return this.storage.storeWelcome(record);
  }

  fetchPendingWelcomes(targetStablePubkey: string): WelcomeQueueRecord[] {
    return this.storage.fetchPendingWelcomes(targetStablePubkey);
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

  subscribeGroupMessages(
    input: SubscribeGroupMessagesInput,
  ): GroupMessageSubscription {
    const queue = new AsyncMessageQueue();
    const subscribers = this.groupSubscribers.get(input.groupId) ?? new Set();

    if (!this.groupSubscribers.has(input.groupId)) {
      this.groupSubscribers.set(input.groupId, subscribers);
    }

    subscribers.add(queue);

    return {
      messages: queue,
      unsubscribe: () => {
        queue.close();
        subscribers.delete(queue);
        if (subscribers.size === 0) {
          this.groupSubscribers.delete(input.groupId);
        }
      },
    };
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

  snapshot(): DeliveryServiceSnapshot {
    return this.storage.snapshot();
  }
}

export function createCoordinator(
  options: CoordinatorOptions = {},
): Coordinator {
  return new Coordinator(options);
}
