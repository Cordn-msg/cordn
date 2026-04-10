import type { KeyPackage, Welcome } from "ts-mls"

export type StablePublicKey = string
export type DeliveryPublicKey = string

export interface PublishedKeyPackageRecord {
  id: string
  stablePubkey: StablePublicKey
  keyPackage: KeyPackage
  keyPackageRef: string
  publishedAt: number
}

export interface WelcomeQueueRecord {
  id: string
  targetStablePubkey: StablePublicKey
  keyPackageReference: string
  welcome: Welcome
  createdAt: number
}

export interface GroupRoutingRecord {
  groupId: string
  latestHandshakeEpoch: bigint
  lastMessageCursor?: number
}

export interface GroupMessageRecord {
  cursor: number
  groupId: string
  ephemeralSenderPubkey: DeliveryPublicKey
  opaqueMessage: Uint8Array
  createdAt: number
}

export interface PublishKeyPackageInput {
  stablePubkey: StablePublicKey
  keyPackage: KeyPackage
  keyPackageRef: string
}

export interface StoreWelcomeInput {
  targetStablePubkey: StablePublicKey
  keyPackageReference: string
  welcome: Welcome
}

export interface PostGroupMessageInput {
  ephemeralSenderPubkey: DeliveryPublicKey
  opaqueMessage: Uint8Array
}

export interface FetchGroupMessagesInput {
  groupId: string
  afterCursor?: number
}

export interface DeliveryServiceSnapshot {
  stableIdentities: number
  publishedKeyPackages: number
  pendingWelcomes: number
  trackedGroups: number
  queuedMessages: number
}
