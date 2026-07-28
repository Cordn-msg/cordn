/**
 * Domain-typed coordinator transport seam. The SDK client talks to coordinators
 * through this interface in rich types (KeyPackage/Welcome objects, Uint8Array),
 * not wire/base64. Each transport implementation handles its own wire encoding:
 *
 *   - `InProcessTransport` (`@cordn/sdk/testing`): passes straight to
 *     `@cordn/coordinator` — zero encoding, zero network. Dev/test only.
 *   - `ContextVmTransport` (`@cordn/sdk/extra`): encodes to the MCP/base64 wire
 *     contract and routes authed/ephemeral channels. Its `McpConnection` seam
 *     is satisfied by `@contextvm/sdk` in production.
 *
 * The authed/ephemeral channel split (design #4) is a privacy invariant owned
 * by each transport implementation; the SDK client never selects a channel.
 */
import type { KeyPackage, Welcome } from "ts-mls";
import type { NostrEvent } from "nostr-tools";
import type { ConsumedJoinRequestRef, ConsumedWelcomeRef } from "@cordn/core";

export interface PublishedKeyPackage {
  stablePubkey: string;
  keyPackage: KeyPackage;
  keyPackageRef: string;
  isLastResort: boolean;
  publishedAt: number;
  publicationEvent: NostrEvent;
}

export interface WelcomeQueueItem {
  targetStablePubkey: string;
  keyPackageReference: string;
  welcome: Welcome;
  createdAt: number;
  joinAfterCursor?: number;
}

export interface JoinRequestItem {
  groupId: string;
  requesterStablePubkey: string;
  keyPackageRef: string;
  createdAt: number;
}

export interface TransportGroupMessage {
  cursor: number;
  groupId: string;
  opaqueMessage: Uint8Array;
  createdAt: number;
}

export interface GroupMessageStream {
  messages: AsyncIterable<TransportGroupMessage>;
  unsubscribe(): void;
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
  groupId: string;
  opaqueMessage: Uint8Array;
}

export interface FetchGroupMessagesInput {
  groupId: string;
  afterCursor?: number;
}

/**
 * Coordinator operations the SDK client needs, in domain types. Implementations
 * must preserve the authed/ephemeral routing invariant internally.
 */
export interface CordnTransport {
  publishKeyPackage(
    input: PublishKeyPackageInput,
  ): Promise<PublishedKeyPackage>;
  listKeyPackages(stablePubkey: string): Promise<PublishedKeyPackage[]>;
  consumeKeyPackage(keyPackageRef: string): Promise<PublishedKeyPackage | null>;
  removeKeyPackage(keyPackageRef: string): Promise<PublishedKeyPackage | null>;

  storeWelcome(input: StoreWelcomeInput): Promise<WelcomeQueueItem>;
  fetchPendingWelcomes(
    targetStablePubkey: string,
    consumed?: ConsumedWelcomeRef[],
  ): Promise<WelcomeQueueItem[]>;

  storeJoinRequest(input: StoreJoinRequestInput): Promise<JoinRequestItem>;
  fetchPendingJoinRequests(
    groupId: string,
    consumed?: ConsumedJoinRequestRef[],
  ): Promise<JoinRequestItem[]>;

  postGroupMessage(
    input: PostGroupMessageInput,
  ): Promise<TransportGroupMessage>;
  fetchGroupMessages(
    input: FetchGroupMessagesInput,
  ): Promise<TransportGroupMessage[]>;
  subscribeGroupMessages(
    input: FetchGroupMessagesInput,
  ): Promise<GroupMessageStream>;
}
