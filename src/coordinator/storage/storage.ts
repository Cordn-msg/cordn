import type {
  ConsumedJoinRequestRef,
  ConsumedJoinRequestWithGroupRef,
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

/** Maximum pending join requests per group. Applies uniformly to all
 *  groups (including those with no message history yet) so a freshly created
 *  group can still accept requests. */
export const MAX_PENDING_JOIN_REQUESTS_PER_GROUP = 100;

/** Partition multi-group consumed refs into per-group lists. Shared by both
 *  storage backends' fetchManyPendingJoinRequests. */
export function partitionConsumedJoinRequests(
  consumed: ConsumedJoinRequestWithGroupRef[] | undefined,
): Map<string, ConsumedJoinRequestRef[]> {
  const byGroup = new Map<string, ConsumedJoinRequestRef[]>();
  for (const item of consumed ?? []) {
    const list = byGroup.get(item.groupId) ?? [];
    list.push(item);
    byGroup.set(item.groupId, list);
  }
  return byGroup;
}

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
  /** @deprecated Only meaningful for legacy (unencrypted) messages.
   *  Encrypted messages pass 0n and the column is left at its default. */
  latestHandshakeEpoch: bigint;
  /** @deprecated NULL for encrypted messages. Retained for legacy
   *  clients that use server-side since_epoch filtering. */
  epoch: bigint;
  ephemeralSenderPubkey: string;
  opaqueMessage: Uint8Array;
  createdAt: number;
  encrypted: boolean;
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
   * Fetch all pending welcomes for a target identity.
   *
   * Observation never deletes. Pass `consumed` to atomically retire welcomes
   * the caller has already joined (keyed by `keyPackageReference` +
   * `createdAt`, scoped to `targetStablePubkey`). Consumed records are deleted
   * before the fetch, so they are never echoed back.
   */
  fetchPendingWelcomes(
    targetStablePubkey: string,
    consumed?: ConsumedWelcomeRef[],
  ): WelcomeQueueRecord[];
  /**
   * Delete welcomes older than the max-age ceiling.
   *
   * A single clock: records whose `createdAt < maxAgeThreshold` are deleted.
   * Pass `0` to delete nothing (retention disabled). Returns the number of
   * deleted records.
   */
  deleteExpiredWelcomes(maxAgeThreshold: number): number;
  storeJoinRequest(record: JoinRequestRecord): JoinRequestRecord;
  /**
   * Fetch all pending join requests for a group.
   *
   * Observation never deletes. Pass `consumed` to atomically retire requests
   * the admin has handled (keyed by `requesterStablePubkey` + `createdAt`,
   * scoped to `groupId`). Consumed records are deleted before the fetch, so
   * they are never echoed back.
   */
  fetchPendingJoinRequests(
    groupId: string,
    consumed?: ConsumedJoinRequestRef[],
  ): JoinRequestRecord[];
  /**
   * Fetch all pending join requests for multiple groups.
   *
   * Same read/consumed semantics as {@link fetchPendingJoinRequests}, but
   * consumed items carry their own `groupId` since they may span the
   * requested groups. Results must be ordered by input group order, then
   * storage order within each group.
   */
  fetchManyPendingJoinRequests(
    input: FetchManyPendingJoinRequestsInput,
  ): JoinRequestRecord[];
  /**
   * Delete join requests older than the max-age ceiling.
   *
   * A single clock: records whose `createdAt < maxAgeThreshold` are deleted.
   * Pass `0` to delete nothing (retention disabled). Returns the number of
   * deleted records.
   */
  deleteExpiredJoinRequests(maxAgeThreshold: number): number;
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
