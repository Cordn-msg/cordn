import type {
  FetchManyGroupMessagesInput,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  JoinRequestRecord,
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
  private readonly joinRequestsByGroup = new Map<string, JoinRequestRecord[]>();
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

  deleteExpiredWelcomes(
    readThreshold: number,
    unreadThreshold: number,
  ): number {
    let deleted = 0;

    for (const [targetStablePubkey, records] of this.welcomesByIdentity) {
      const kept = records.filter(
        (record) =>
          (record.readAt === null && record.createdAt >= unreadThreshold) ||
          (record.readAt !== null && record.readAt >= readThreshold),
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

  storeJoinRequest(record: JoinRequestRecord): JoinRequestRecord {
    const existing = this.joinRequestsByGroup.get(record.groupId) ?? [];
    const duplicate = existing.find(
      (req) =>
        req.requesterStablePubkey === record.requesterStablePubkey &&
        req.readAt === null,
    );
    if (duplicate) {
      return duplicate;
    }

    const stored: JoinRequestRecord = { ...record };
    existing.push(stored);
    this.joinRequestsByGroup.set(record.groupId, existing);

    return stored;
  }

  fetchPendingJoinRequests(groupId: string, now: number): JoinRequestRecord[] {
    const records = this.joinRequestsByGroup.get(groupId) ?? [];
    for (const record of records) {
      if (record.readAt === null) {
        record.readAt = now;
      }
    }
    return records;
  }

  deleteExpiredJoinRequests(
    readThreshold: number,
    unreadThreshold: number,
  ): number {
    let deleted = 0;

    for (const [groupId, records] of this.joinRequestsByGroup) {
      const kept = records.filter(
        (record) =>
          (record.readAt === null && record.createdAt >= unreadThreshold) ||
          (record.readAt !== null && record.readAt >= readThreshold),
      );
      deleted += records.length - kept.length;

      if (kept.length === 0) {
        this.joinRequestsByGroup.delete(groupId);
      } else {
        this.joinRequestsByGroup.set(groupId, kept);
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
      epoch: params.epoch,
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
    const sinceEpoch = input.sinceEpoch;
    const afterCursor = input.afterCursor;

    let filtered = messages;
    if (sinceEpoch !== undefined && sinceEpoch > 0n) {
      filtered = messages.filter((record) => record.epoch >= sinceEpoch);
    }

    if (afterCursor === undefined) {
      return filtered;
    }

    return filtered.filter((record) => record.cursor > afterCursor);
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
