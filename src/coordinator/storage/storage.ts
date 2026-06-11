import type {
  FetchManyGroupMessagesInput,
  FetchManyPendingJoinRequestsInput,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  JoinRequestRecord,
  PublishedKeyPackageRecord,
  WelcomeQueueRecord,
} from "../types.ts";

/**
 * Maximum number of pending (unread) join requests allowed per group.
 * This cap applies uniformly to all groups regardless of whether the group
 * has message history in the coordinator. It prevents unbounded accumulation
 * while allowing the bootstrap scenario of a freshly created group with no
 * messages to still accept join requests.
 */
export const MAX_PENDING_JOIN_REQUESTS_PER_GROUP = 100;

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
  epoch: bigint;
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
  /**
   * Fetch all pending welcomes for a target identity and mark unread
   * welcomes as read at the given timestamp.
   *
   * Welcomes whose `readAt` is already set are returned without updating
   * their timestamp, preserving the original read time for TTL calculations.
   * This method never deletes records; cleanup is handled separately via
   * {@link deleteExpiredWelcomes}.
   */
  fetchPendingWelcomes(
    targetStablePubkey: string,
    now: number,
  ): WelcomeQueueRecord[];
  /**
   * Delete expired welcomes.
   *
   * Two independent expiration conditions are applied:
   * - Read welcomes whose `readAt` is older than `readThreshold`.
   * - Unread welcomes whose `createdAt` is older than `unreadThreshold`.
   *
   * When `unreadThreshold` is 0 (epoch) the second condition never matches,
   * preserving the current "unread lives forever" behavior.
   * Returns the number of deleted records.
   */
  deleteExpiredWelcomes(readThreshold: number, unreadThreshold: number): number;
  storeJoinRequest(record: JoinRequestRecord): JoinRequestRecord;
  /**
   * Fetch all pending join requests for a group and mark unread
   * requests as read at the given timestamp.
   *
   * Requests whose `readAt` is already set are returned without updating
   * their timestamp, preserving the original read time for TTL calculations.
   * This method never deletes records; cleanup is handled separately via
   * {@link deleteExpiredJoinRequests}.
   */
  fetchPendingJoinRequests(groupId: string, now: number): JoinRequestRecord[];
  /**
   * Fetch all pending join requests for multiple groups and mark unread
   * requests as read at the given timestamp.
   *
   * Requests whose `readAt` is already set are returned without updating
   * their timestamp, preserving the original read time for TTL calculations.
   * This method never deletes records; cleanup is handled separately via
   * {@link deleteExpiredJoinRequests}.
   *
   * Results must be ordered by input group order, then storage order within
   * each group.
   */
  fetchManyPendingJoinRequests(
    input: FetchManyPendingJoinRequestsInput,
    now: number,
  ): JoinRequestRecord[];
  /**
   * Delete expired join requests.
   *
   * Two independent expiration conditions are applied:
   * - Read requests whose `readAt` is older than `readThreshold`.
   * - Unread requests whose `createdAt` is older than `unreadThreshold`.
   *
   * When `unreadThreshold` is 0 (epoch) the second condition never matches,
   * preserving the current "unread lives forever" behavior.
   * Returns the number of deleted records.
   */
  deleteExpiredJoinRequests(
    readThreshold: number,
    unreadThreshold: number,
  ): number;
  appendGroupMessage(params: AppendGroupMessageParams): GroupMessageRecord;
  /**
   * Fetch messages for one group only. If `afterCursor` is provided, it is a
   * cursor previously returned for that same group.
   */
  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[];
  /**
   * Fetch messages for multiple groups while preserving independent per-group
   * cursor semantics. Results must be ordered by input group order, then cursor
   * ascending within each group.
   */
  fetchManyGroupMessages(
    input: FetchManyGroupMessagesInput,
  ): GroupMessageRecord[];
  getGroupRouting(groupId: string): GroupRoutingRecord | null;
  close?(): void;
}
