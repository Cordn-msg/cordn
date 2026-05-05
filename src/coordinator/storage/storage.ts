import type {
  DeliveryServiceSnapshot,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  PublishedKeyPackageRecord,
  WelcomeQueueRecord,
} from "../types.ts";

/**
 * Storage instances are owned by a single coordinator instance.
 *
 * The contract is intentionally domain-shaped and assumes a single-writer
 * execution model, which allows the coordinator to perform read/decide/write
 * flows without optimistic concurrency tokens.
 *
 * Group message cursor invariants:
 * - cursors are monotonic within a group
 * - cursors are scoped to a group, not globally across all groups
 * - different groups may each have a message with cursor 1
 * - `fetchGroupMessages({ groupId, afterCursor })` must interpret
 *   `afterCursor` only within the specified group
 * - `getGroupRouting(groupId)?.lastMessageCursor` must equal the highest
 *   cursor persisted for that same group.
 */
export interface AppendGroupMessageParams {
  groupId: string;
  latestHandshakeEpoch: bigint;
  ephemeralSenderPubkey: string;
  opaqueMessage: Uint8Array;
  createdAt: number;
}

export interface CoordinatorStorage {
  /**
   * Persist a group message and allocate the next cursor for `record.groupId`.
   *
   * Implementations must never use a table-global cursor sequence here.
   */
  publishKeyPackage(
    record: PublishedKeyPackageRecord,
  ): PublishedKeyPackageRecord;
  listKeyPackagesForIdentity(stablePubkey: string): PublishedKeyPackageRecord[];
  listAllKeyPackages(): PublishedKeyPackageRecord[];
  getKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null;
  removeKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null;
  consumeKeyPackage(identifier: string): PublishedKeyPackageRecord | null;
  storeWelcome(record: WelcomeQueueRecord): WelcomeQueueRecord;
  fetchPendingWelcomes(targetStablePubkey: string): WelcomeQueueRecord[];
  appendGroupMessage(params: AppendGroupMessageParams): GroupMessageRecord;
  /**
   * Fetch messages for one group only. If `afterCursor` is provided, it is a
   * cursor previously returned for that same group.
   */
  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[];
  getGroupRouting(groupId: string): GroupRoutingRecord | null;
  snapshot(): DeliveryServiceSnapshot;
  close?(): void;
}
