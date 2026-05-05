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
  private readonly keyPackagesByIdentity = new Map<
    string,
    PublishedKeyPackageRecord[]
  >();
  private readonly welcomesByIdentity = new Map<string, WelcomeQueueRecord[]>();
  private readonly groups = new Map<string, GroupLog>();

  publishKeyPackage(
    record: PublishedKeyPackageRecord,
  ): PublishedKeyPackageRecord {
    const records = this.keyPackagesByIdentity.get(record.stablePubkey) ?? [];
    records.push(record);
    this.keyPackagesByIdentity.set(record.stablePubkey, records);

    return record;
  }

  listKeyPackagesForIdentity(
    stablePubkey: string,
  ): PublishedKeyPackageRecord[] {
    return this.keyPackagesByIdentity.get(stablePubkey) ?? [];
  }

  listAllKeyPackages(): PublishedKeyPackageRecord[] {
    const records: PublishedKeyPackageRecord[] = [];

    for (const keyPackages of this.keyPackagesByIdentity.values()) {
      for (let index = 0; index < keyPackages.length; index += 1) {
        records.push(keyPackages[index]!);
      }
    }

    return records;
  }

  getKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    const located = this.findKeyPackage(keyPackageRef);
    if (located) {
      return located.record;
    }

    return null;
  }

  removeKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    const located = this.findKeyPackage(keyPackageRef);
    if (!located) {
      return null;
    }

    const { stablePubkey, index, records } = located;
    const [removed] = records.splice(index, 1);
    if (records.length === 0) {
      this.keyPackagesByIdentity.delete(stablePubkey);
    }

    return removed ?? null;
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
    for (const records of this.keyPackagesByIdentity.values()) {
      publishedKeyPackages += records.length;
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
    const records = this.keyPackagesByIdentity.get(stablePubkey);
    if (!records || records.length === 0) {
      return null;
    }

    const regular = records.find((record) => !record.isLastResort);
    if (regular) {
      return this.removeKeyPackage(regular.keyPackageRef);
    }

    return records.at(-1) ?? null;
  }

  private consumeKeyPackageByReference(
    keyPackageRef: string,
  ): PublishedKeyPackageRecord | null {
    const record = this.getKeyPackage(keyPackageRef);
    if (!record) {
      return null;
    }

    return record.isLastResort ? record : this.removeKeyPackage(keyPackageRef);
  }

  private findKeyPackage(keyPackageRef: string):
    | {
        stablePubkey: string;
        index: number;
        records: PublishedKeyPackageRecord[];
        record: PublishedKeyPackageRecord;
      }
    | undefined {
    for (const [
      stablePubkey,
      records,
    ] of this.keyPackagesByIdentity.entries()) {
      const index = records.findIndex(
        (candidate) => candidate.keyPackageRef === keyPackageRef,
      );
      if (index >= 0) {
        return {
          stablePubkey,
          index,
          records,
          record: records[index]!,
        };
      }
    }

    return undefined;
  }
}
