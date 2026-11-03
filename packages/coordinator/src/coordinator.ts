import type {
  ConsumedJoinRequestRef,
  ConsumedWelcomeRef,
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
import { encodeWelcome, isLastResortKeyPackage } from "@cordn/core";

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export interface CoordinatorOptions {
  storage?: CoordinatorStorage;
  now?: () => number;
  /** Interval in ms between cleanup runs. Set to 0 to disable. Default: 6h
   *  (programmatic/test override; the production cadence is not env-tunable —
   *  only the max-age policy is, via CORDN_MAX_AGE_DAYS). */
  cleanupIntervalMs?: number;
  /** Max age in ms for welcome and join request records. Records older than
   *  this are deleted. Set to 0 or negative to disable (keep forever).
   *  Default: 30 days (2_592_000_000).
   *
   *  Observation (fetch) never deletes; only explicit `consumed` acks or
   *  this ceiling remove records. */
  maxAgeMs?: number;
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
  // Distinct-subscriber refcount. A multi-group sub joins N group Sets with one
  // subscriber object, so summed Set sizes over-count; this counts each object
  // once. O(1) for getActiveSubscriptionCount.
  private readonly subscriberRefcounts = new Map<
    GroupMessageSubscriber,
    number
  >();
  private readonly cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CoordinatorOptions = {}) {
    this.storage = options.storage ?? new InMemoryCoordinatorStorage();
    this.now = options.now ?? Date.now;

    const intervalMs = options.cleanupIntervalMs ?? 21_600_000; // 6 hours
    if (intervalMs > 0) {
      const maxAgeMs = options.maxAgeMs ?? 2_592_000_000; // 30 days
      this.cleanupTimer = setInterval(() => {
        const threshold = maxAgeMs > 0 ? this.now() - maxAgeMs : 0;
        this.deleteExpiredWelcomes(threshold);
        this.deleteExpiredJoinRequests(threshold);
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
    // `consumed` identifies a record by (kp_ref, at). Last-resort KPs are
    // reusable, so make `at` unique within that target/ref even on millisecond
    // clocks and across coordinator restarts. ponytail: queues are TTL-bounded;
    // add a storage max query only if this scan becomes measurable.
    const pending = this.storage.fetchPendingWelcomes(input.targetStablePubkey);
    const encodedWelcome = encodeWelcome(input.welcome);
    const duplicate = pending.find(
      (record) =>
        record.keyPackageReference === input.keyPackageReference &&
        record.joinAfterCursor === input.joinAfterCursor &&
        bytesEqual(encodeWelcome(record.welcome), encodedWelcome),
    );
    if (duplicate) return duplicate;

    const createdAt = pending
      .filter(
        (record) => record.keyPackageReference === input.keyPackageReference,
      )
      .reduce((at, record) => Math.max(at, record.createdAt + 1), this.now());
    const record: WelcomeQueueRecord = {
      targetStablePubkey: input.targetStablePubkey,
      senderStablePubkey: input.senderStablePubkey,
      keyPackageReference: input.keyPackageReference,
      welcome: input.welcome,
      createdAt,
      joinAfterCursor: input.joinAfterCursor,
    };

    return this.storage.storeWelcome(record);
  }

  fetchPendingWelcomes(
    targetStablePubkey: string,
    consumed?: ConsumedWelcomeRef[],
  ): WelcomeQueueRecord[] {
    return this.storage.fetchPendingWelcomes(targetStablePubkey, consumed);
  }

  deleteExpiredWelcomes(maxAgeThreshold: number): number {
    return this.storage.deleteExpiredWelcomes(maxAgeThreshold);
  }

  storeJoinRequest(input: StoreJoinRequestInput): JoinRequestRecord {
    // Join-request acks use (requester pk, at), with the same uniqueness need.
    const createdAt = this.storage
      .fetchPendingJoinRequests(input.groupId)
      .filter(
        (record) =>
          record.requesterStablePubkey === input.requesterStablePubkey,
      )
      .reduce((at, record) => Math.max(at, record.createdAt + 1), this.now());
    const record: JoinRequestRecord = {
      groupId: input.groupId,
      requesterStablePubkey: input.requesterStablePubkey,
      keyPackageRef: input.keyPackageRef,
      createdAt,
    };

    return this.storage.storeJoinRequest(record);
  }

  fetchPendingJoinRequests(
    groupId: string,
    consumed?: ConsumedJoinRequestRef[],
  ): JoinRequestRecord[] {
    return this.storage.fetchPendingJoinRequests(groupId, consumed);
  }

  fetchManyPendingJoinRequests(
    input: FetchManyPendingJoinRequestsInput,
  ): JoinRequestRecord[] {
    return this.storage.fetchManyPendingJoinRequests(input);
  }

  deleteExpiredJoinRequests(maxAgeThreshold: number): number {
    return this.storage.deleteExpiredJoinRequests(maxAgeThreshold);
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  postGroupMessage(input: PostGroupMessageInput): GroupMessageRecord {
    const record = this.storage.appendGroupMessage({
      groupId: input.groupId,
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
    this.subscriberRefcounts.set(
      subscriber,
      (this.subscriberRefcounts.get(subscriber) ?? 0) + 1,
    );
  }

  private removeGroupSubscriber(
    groupId: string,
    subscriber: GroupMessageSubscriber,
  ): void {
    const subscribers = this.groupSubscribers.get(groupId);
    if (!subscribers) {
      return;
    }

    if (subscribers.delete(subscriber)) {
      const next = (this.subscriberRefcounts.get(subscriber) ?? 0) - 1;
      if (next <= 0) {
        this.subscriberRefcounts.delete(subscriber);
      } else {
        this.subscriberRefcounts.set(subscriber, next);
      }
    }
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
    return this.subscriberRefcounts.size;
  }
}

export function createCoordinator(
  options: CoordinatorOptions = {},
): Coordinator {
  return new Coordinator(options);
}
