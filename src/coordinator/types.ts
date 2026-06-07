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

export interface GroupRoutingRecord {
  groupId: string;
  latestHandshakeEpoch: bigint;
  lastMessageCursor: number;
}

export interface GroupMessageRecord {
  cursor: number;
  groupId: string;
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

export interface PostGroupMessageInput {
  ephemeralSenderPubkey: string;
  opaqueMessage: Uint8Array;
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
