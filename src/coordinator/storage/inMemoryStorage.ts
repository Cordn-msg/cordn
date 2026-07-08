import type {
  ConsumedJoinRequestRef,
  ConsumedWelcomeRef,
  FetchManyGroupMessagesInput,
  FetchManyPendingJoinRequestsInput,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  JoinRequestRecord,
  PublishedKeyPackageRecord,
  WelcomeQueueRecord,
} from "../types.ts";

import {
  type AppendGroupMessageParams,
  type CoordinatorStorage,
  MAX_PENDING_JOIN_REQUESTS_PER_GROUP,
  partitionConsumedJoinRequests,
} from "./storage.ts";

interface GroupLog {
  nextCursor: number;
  routing: GroupRoutingRecord;
  messages: GroupMessageRecord[];
}

function createGroupLog(groupId: string): GroupLog {
  return {
    nextCursor: 1,
    routing: {
      groupId,
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
    consumed?: ConsumedWelcomeRef[],
  ): WelcomeQueueRecord[] {
    const records = this.welcomesByIdentity.get(targetStablePubkey) ?? [];
    const remaining =
      consumed && consumed.length > 0
        ? records.filter(
            (record) =>
              !consumed.some(
                (c) =>
                  c.keyPackageReference === record.keyPackageReference &&
                  c.createdAt === record.createdAt,
              ),
          )
        : records;

    if (remaining !== records) {
      if (remaining.length === 0) {
        this.welcomesByIdentity.delete(targetStablePubkey);
      } else {
        this.welcomesByIdentity.set(targetStablePubkey, remaining);
      }
    }

    return remaining;
  }

  deleteExpiredWelcomes(maxAgeThreshold: number): number {
    if (maxAgeThreshold <= 0) {
      return 0;
    }

    let deleted = 0;

    for (const [targetStablePubkey, records] of this.welcomesByIdentity) {
      const kept = records.filter(
        (record) => record.createdAt >= maxAgeThreshold,
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
      (req) => req.requesterStablePubkey === record.requesterStablePubkey,
    );
    if (duplicate) {
      // Re-request: refresh in place. The consume-ack model retires rows by
      // (group, requester, createdAt), so bumping createdAt evades an admin's
      // already-recorded consume ref and the updated keyPackageRef makes the
      // admin accept with the requester's current key package. Without this a
      // re-request silently returns the stale row and the admin's next fetch
      // consumes it away — making the user send twice.
      duplicate.keyPackageRef = record.keyPackageRef;
      duplicate.createdAt = record.createdAt;
      return { ...duplicate };
    }

    // New row — enforce the per-group cap only on the insert path.
    if (existing.length >= MAX_PENDING_JOIN_REQUESTS_PER_GROUP) {
      throw new Error("Too many pending join requests for this group");
    }

    const stored: JoinRequestRecord = { ...record };
    existing.push(stored);
    this.joinRequestsByGroup.set(record.groupId, existing);

    return stored;
  }

  fetchPendingJoinRequests(
    groupId: string,
    consumed?: ConsumedJoinRequestRef[],
  ): JoinRequestRecord[] {
    const records = this.joinRequestsByGroup.get(groupId) ?? [];
    const remaining =
      consumed && consumed.length > 0
        ? records.filter(
            (record) =>
              !consumed.some(
                (c) =>
                  c.requesterStablePubkey === record.requesterStablePubkey &&
                  c.createdAt === record.createdAt,
              ),
          )
        : records;

    if (remaining !== records) {
      if (remaining.length === 0) {
        this.joinRequestsByGroup.delete(groupId);
      } else {
        this.joinRequestsByGroup.set(groupId, remaining);
      }
    }

    return remaining;
  }

  fetchManyPendingJoinRequests(
    input: FetchManyPendingJoinRequestsInput,
  ): JoinRequestRecord[] {
    const consumedByGroup = partitionConsumedJoinRequests(input.consumed);
    return input.groups.flatMap((group) =>
      this.fetchPendingJoinRequests(
        group.groupId,
        consumedByGroup.get(group.groupId),
      ),
    );
  }

  deleteExpiredJoinRequests(maxAgeThreshold: number): number {
    if (maxAgeThreshold <= 0) {
      return 0;
    }

    let deleted = 0;

    for (const [groupId, records] of this.joinRequestsByGroup) {
      const kept = records.filter(
        (record) => record.createdAt >= maxAgeThreshold,
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
      this.groups.get(params.groupId) ?? createGroupLog(params.groupId);

    const record: GroupMessageRecord = {
      cursor: group.nextCursor,
      groupId: params.groupId,
      opaqueMessage: params.opaqueMessage,
      createdAt: params.createdAt,
      encrypted: params.encrypted,
    };
    group.nextCursor += 1;

    group.messages.push(record);
    group.routing.lastMessageCursor = record.cursor;

    this.groups.set(params.groupId, group);

    return record;
  }

  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[] {
    const messages = this.groups.get(input.groupId)?.messages ?? [];
    const afterCursor = input.afterCursor;
    if (afterCursor === undefined) {
      return messages;
    }
    return messages.filter((record) => record.cursor > afterCursor);
  }

  fetchManyGroupMessages(
    input: FetchManyGroupMessagesInput,
  ): GroupMessageRecord[] {
    return input.groups.flatMap((group) => this.fetchGroupMessages(group));
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
