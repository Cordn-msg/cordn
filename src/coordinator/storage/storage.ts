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
 */
export interface AppendGroupMessageParams {
  groupId: string;
  latestHandshakeEpoch: bigint;
  ephemeralSenderPubkey: string;
  opaqueMessage: Uint8Array;
  createdAt: number;
}

export interface CoordinatorStorage {
  publishKeyPackage(
    record: PublishedKeyPackageRecord,
  ): PublishedKeyPackageRecord;
  listKeyPackagesForIdentity(stablePubkey: string): PublishedKeyPackageRecord[];
  listAllKeyPackages(): PublishedKeyPackageRecord[];
  consumeKeyPackage(identifier: string): PublishedKeyPackageRecord | null;
  storeWelcome(record: WelcomeQueueRecord): WelcomeQueueRecord;
  fetchPendingWelcomes(targetStablePubkey: string): WelcomeQueueRecord[];
  appendGroupMessage(params: AppendGroupMessageParams): GroupMessageRecord;
  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[];
  getGroupRouting(groupId: string): GroupRoutingRecord | null;
  snapshot(): DeliveryServiceSnapshot;
  close?(): void;
}
