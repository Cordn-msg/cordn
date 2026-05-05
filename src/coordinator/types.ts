import type { KeyPackage, Welcome } from "ts-mls";

export interface PublishedKeyPackageRecord {
  stablePubkey: string;
  keyPackage: KeyPackage;
  keyPackageRef: string;
  isLastResort: boolean;
  publishedAt: number;
}

export interface WelcomeQueueRecord {
  targetStablePubkey: string;
  keyPackageReference: string;
  welcome: Welcome;
  createdAt: number;
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

export interface DeliveryServiceSnapshot {
  stableIdentities: number;
  publishedKeyPackages: number;
  pendingWelcomes: number;
  trackedGroups: number;
  queuedMessages: number;
}
