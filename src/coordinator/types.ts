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
  readAt: number | null;
}

export interface JoinRequestRecord {
  groupId: string;
  requesterStablePubkey: string;
  keyPackageRef: string;
  createdAt: number;
  readAt: number | null;
}

export interface GroupRoutingRecord {
  groupId: string;
  latestHandshakeEpoch: bigint;
  lastMessageCursor: number;
}

export interface GroupMessageRecord {
  cursor: number;
  groupId: string;
  epoch: bigint;
  ephemeralSenderPubkey: string;
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
}

export interface StoreJoinRequestInput {
  groupId: string;
  requesterStablePubkey: string;
  keyPackageRef: string;
}

export interface PostGroupMessageInput {
  ephemeralSenderPubkey: string;
  opaqueMessage: Uint8Array;
}

export interface FetchGroupMessagesInput {
  groupId: string;
  afterCursor?: number;
  sinceEpoch?: bigint;
}

export type SubscribeGroupMessagesInput = FetchGroupMessagesInput;

export interface FetchManyGroupMessagesInput {
  groups: FetchGroupMessagesInput[];
}

export type SubscribeManyGroupMessagesInput = FetchManyGroupMessagesInput;

export interface FetchManyPendingJoinRequestsInput {
  groups: { groupId: string }[];
}
