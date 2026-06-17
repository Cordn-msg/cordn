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
  joinAfterCursor?: number;
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
  /** @deprecated No longer tracked for encrypted messages. Retained for
   *  backward compatibility with legacy clients during transition. */
  latestHandshakeEpoch: bigint;
  lastMessageCursor: number;
}

export interface GroupMessageRecord {
  cursor: number;
  groupId: string;
  /** @deprecated NULL for encrypted messages. Retained for legacy
   *  clients that use server-side since_epoch filtering. */
  epoch: bigint;
  /** @deprecated Only meaningful for legacy (unencrypted) messages.
   *  Encrypted messages use the caller-supplied outer gid for routing. */
  ephemeralSenderPubkey: string;
  opaqueMessage: Uint8Array;
  createdAt: number;
  encrypted: boolean;
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
  ephemeralSenderPubkey: string;
  opaqueMessage: Uint8Array;
  /** Outer delivery group id for encrypted messages. When provided the
   *  coordinator skips MLS decoding and routes by this gid directly. */
  groupId?: string;
}

export interface FetchGroupMessagesInput {
  groupId: string;
  afterCursor?: number;
  /** @deprecated Replaced by client-side encryption that naturally filters
   *  messages from epochs the client has not joined. */
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
