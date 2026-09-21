import type { NostrEvent } from "nostr-tools";
import type { KeyPackage, Welcome } from "ts-mls";
import type { ConsumedJoinRequestRef, ConsumedWelcomeRef } from "@cordn/core";

export type { ConsumedJoinRequestRef, ConsumedWelcomeRef };

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
  senderStablePubkey?: string;
  keyPackageReference: string;
  welcome: Welcome;
  createdAt: number;
  joinAfterCursor?: number;
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
  senderStablePubkey?: string;
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
