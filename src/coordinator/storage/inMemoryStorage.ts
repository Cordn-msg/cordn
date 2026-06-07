import type {
  FetchManyGroupMessagesInput,
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
    const stored: WelcomeQueueRecord = { ...record };
    const existing =
      this.welcomesByIdentity.get(stored.targetStablePubkey) ?? [];
    existing.push(stored);
    this.welcomesByIdentity.set(stored.targetStablePubkey, existing);

    return stored;
  }

  fetchPendingWelcomes(
    targetStablePubkey: string,
    now: number,
  ): WelcomeQueueRecord[] {
    const records = this.welcomesByIdentity.get(targetStablePubkey) ?? [];
    for (const record of records) {
      if (record.readAt === null) {
        record.readAt = now;
      }
    }
    return records;
  }

  deleteExpiredWelcomes(threshold: number): number {
    let deleted = 0;

    for (const [targetStablePubkey, records] of this.welcomesByIdentity) {
      const kept = records.filter(
        (record) => record.readAt === null || record.readAt >= threshold,
      );
      deleted += records.length - kept.length;

      if (kept.length === 0) {
        this.welcomesByIdentity.delete(targetStablePubkey);
      } else {
        this.welcomesByIdentity.set(targetStablePubkey, kept);
      }
    }

    return deleted;
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

  fetchManyGroupMessages(
    input: FetchManyGroupMessagesInput,
  ): GroupMessageRecord[] {
    return input.groups.flatMap((group) => this.fetchGroupMessages(group));
  }

  getGroupRouting(groupId: string): GroupRoutingRecord | null {
    return this.groups.get(groupId)?.routing ?? null;
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
