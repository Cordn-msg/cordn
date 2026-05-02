import type {
  DeliveryServiceSnapshot,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  PublishedKeyPackageRecord,
  WelcomeQueueRecord,
} from "../types.ts";

import type {
  AppendGroupMessageParams,
  CoordinatorStorage,
} from "./storage.ts";

interface KeyPackageQueue {
  records: PublishedKeyPackageRecord[];
  head: number;
}

interface GroupLog {
  nextCursor: number;
  routing: GroupRoutingRecord;
  messages: GroupMessageRecord[];
}

function createGroupLog(groupId: string, epoch: bigint): GroupLog {
  return {
    nextCursor: 1,
    routing: {
      groupId,
      latestHandshakeEpoch: epoch,
      lastMessageCursor: 0,
    },
    messages: [],
  };
}

export class InMemoryCoordinatorStorage implements CoordinatorStorage {
  private readonly keyPackagesByIdentity = new Map<string, KeyPackageQueue>();
  private readonly welcomesByIdentity = new Map<string, WelcomeQueueRecord[]>();
  private readonly groups = new Map<string, GroupLog>();

  publishKeyPackage(
    record: PublishedKeyPackageRecord,
  ): PublishedKeyPackageRecord {
    const queue = this.keyPackagesByIdentity.get(record.stablePubkey) ?? {
      records: [],
      head: 0,
    };
    queue.records.push(record);
    this.keyPackagesByIdentity.set(record.stablePubkey, queue);

    return record;
  }

  listKeyPackagesForIdentity(
    stablePubkey: string,
  ): PublishedKeyPackageRecord[] {
    const queue = this.keyPackagesByIdentity.get(stablePubkey);
    if (!queue) {
      return [];
    }

    if (queue.head === 0) {
      return queue.records;
    }

    return queue.records.slice(queue.head);
  }

  listAllKeyPackages(): PublishedKeyPackageRecord[] {
    const records: PublishedKeyPackageRecord[] = [];

    for (const queue of this.keyPackagesByIdentity.values()) {
      for (let index = queue.head; index < queue.records.length; index += 1) {
        records.push(queue.records[index]!);
      }
    }

    return records;
  }

  consumeKeyPackage(identifier: string): PublishedKeyPackageRecord | null {
    const directRecord = this.consumeKeyPackageByReference(identifier);
    if (directRecord) {
      return directRecord;
    }

    return this.consumeKeyPackageByIdentity(identifier);
  }

  storeWelcome(record: WelcomeQueueRecord): WelcomeQueueRecord {
    const existing =
      this.welcomesByIdentity.get(record.targetStablePubkey) ?? [];
    existing.push(record);
    this.welcomesByIdentity.set(record.targetStablePubkey, existing);

    return record;
  }

  fetchPendingWelcomes(targetStablePubkey: string): WelcomeQueueRecord[] {
    const records = this.welcomesByIdentity.get(targetStablePubkey);
    if (!records) {
      return [];
    }

    this.welcomesByIdentity.delete(targetStablePubkey);
    return records;
  }

  appendGroupMessage(params: AppendGroupMessageParams): GroupMessageRecord {
    const group =
      this.groups.get(params.groupId) ??
      createGroupLog(params.groupId, params.latestHandshakeEpoch);

    const record: GroupMessageRecord = {
      cursor: group.nextCursor,
      groupId: params.groupId,
      ephemeralSenderPubkey: params.ephemeralSenderPubkey,
      opaqueMessage: params.opaqueMessage,
      createdAt: params.createdAt,
    };
    group.nextCursor += 1;

    group.messages.push(record);
    group.routing.latestHandshakeEpoch = params.latestHandshakeEpoch;
    group.routing.lastMessageCursor = record.cursor;

    this.groups.set(params.groupId, group);

    return record;
  }

  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[] {
    const messages = this.groups.get(input.groupId)?.messages ?? [];
    if (input.afterCursor === undefined) {
      return messages;
    }

    const startIndex = input.afterCursor;
    if (startIndex <= 0) {
      return messages;
    }

    if (startIndex >= messages.length) {
      return [];
    }

    return messages.slice(startIndex);
  }

  getGroupRouting(groupId: string): GroupRoutingRecord | null {
    return this.groups.get(groupId)?.routing ?? null;
  }

  snapshot(): DeliveryServiceSnapshot {
    let publishedKeyPackages = 0;
    for (const queue of this.keyPackagesByIdentity.values()) {
      publishedKeyPackages += queue.records.length - queue.head;
    }

    const pendingWelcomes = Array.from(this.welcomesByIdentity.values()).reduce(
      (total, current) => total + current.length,
      0,
    );
    let queuedMessages = 0;
    for (const group of this.groups.values()) {
      queuedMessages += group.messages.length;
    }

    return {
      stableIdentities: this.keyPackagesByIdentity.size,
      publishedKeyPackages,
      pendingWelcomes,
      trackedGroups: this.groups.size,
      queuedMessages,
    };
  }

  close(): void {}

  private consumeKeyPackageByIdentity(
    stablePubkey: string,
  ): PublishedKeyPackageRecord | null {
    const queue = this.keyPackagesByIdentity.get(stablePubkey);
    if (!queue || queue.head >= queue.records.length) {
      return null;
    }

    const record = queue.records[queue.head] ?? null;
    if (!record) {
      return null;
    }

    queue.head += 1;

    if (queue.head >= queue.records.length) {
      this.keyPackagesByIdentity.delete(stablePubkey);
    }

    return record;
  }

  private consumeKeyPackageByReference(
    keyPackageRef: string,
  ): PublishedKeyPackageRecord | null {
    for (const [stablePubkey, queue] of this.keyPackagesByIdentity.entries()) {
      for (let index = queue.head; index < queue.records.length; index += 1) {
        const record = queue.records[index];
        if (record?.keyPackageRef !== keyPackageRef) {
          continue;
        }

        if (index === queue.head) {
          return this.consumeKeyPackageByIdentity(stablePubkey);
        }

        queue.records.splice(index, 1);
        if (queue.head >= queue.records.length) {
          this.keyPackagesByIdentity.delete(stablePubkey);
        }

        return record;
      }
    }

    return null;
  }
}
