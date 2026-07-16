import type { NostrEvent } from "nostr-tools";
import type { KeyPackage, Welcome } from "ts-mls";

export interface PublishedKeyPackageRecord {
  stablePubkey: string;
  keyPackage: KeyPackage;
  keyPackageRef: string;
  isLastResort: boolean;
  publishedAt: number;
  publicationEvent: NostrEvent;
}

export interface WelcomeQueueRecord {
  targetStablePubkey: string;
  keyPackageReference: string;
  welcome: Welcome;
  createdAt: number;
  joinAfterCursor?: number;
}

/** Reference to a welcome the caller has consumed (joined locally) and
 *  wants the coordinator to retire. Scoped to the caller's own inbox, so
 *  `(keyPackageReference, createdAt)` uniquely identifies the record. */
export interface ConsumedWelcomeRef {
  keyPackageReference: string;
  createdAt: number;
}

/** Reference to a join request an admin has handled and wants the
 *  coordinator to retire. Scoped to a single group fetch, so
 *  `(requesterStablePubkey, createdAt)` uniquely identifies the record. */
export interface ConsumedJoinRequestRef {
  requesterStablePubkey: string;
  createdAt: number;
}

/** Like {@link ConsumedJoinRequestRef} but carrying its own `groupId`, for
 *  the multi-group fetch where consumed items may span several groups. */
export interface ConsumedJoinRequestWithGroupRef extends ConsumedJoinRequestRef {
  groupId: string;
}

export interface JoinRequestRecord {
  groupId: string;
  requesterStablePubkey: string;
  keyPackageRef: string;
  createdAt: number;
}

export interface GroupRoutingRecord {
  groupId: string;
  lastMessageCursor: number;
}

export interface GroupMessageRecord {
  cursor: number;
  groupId: string;
  opaqueMessage: Uint8Array;
  createdAt: number;
}

export interface PublishKeyPackageInput {
  stablePubkey: string;
  keyPackage: KeyPackage;
  keyPackageRef: string;
  publicationEvent: NostrEvent;
}

export interface StoreWelcomeInput {
  targetStablePubkey: string;
  keyPackageReference: string;
  welcome: Welcome;
  joinAfterCursor?: number;
}

export interface StoreJoinRequestInput {
  groupId: string;
  requesterStablePubkey: string;
  keyPackageRef: string;
}

export interface PostGroupMessageInput {
  opaqueMessage: Uint8Array;
  /** Outer delivery group id. The coordinator routes by this gid directly
   *  and never decodes the MLS payload. */
  groupId: string;
}

export interface FetchGroupMessagesInput {
  groupId: string;
  afterCursor?: number;
}

export type SubscribeGroupMessagesInput = FetchGroupMessagesInput;

export interface FetchManyGroupMessagesInput {
  groups: FetchGroupMessagesInput[];
}

export type SubscribeManyGroupMessagesInput = FetchManyGroupMessagesInput;

export interface FetchManyPendingJoinRequestsInput {
  groups: { groupId: string }[];
  consumed?: ConsumedJoinRequestWithGroupRef[];
}
