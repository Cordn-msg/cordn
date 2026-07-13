import type { ClientState, KeyPackage, PrivateKeyPackage } from "ts-mls";
import type { UnsignedEvent } from "nostr-tools";

import type { PendingWelcome } from "../contracts/index.ts";
import type { CoordinatorTarget } from "./coordinatorRegistry.ts";
import type { CordnGroupMetadata } from "./groupMetadata.ts";
import type { MediaStore } from "./mediaStore.ts";

export interface CliSessionOptions {
  privateKey?: string;
  serverPubkey?: string;
  relays?: string[];
  relayHandler?: import("@contextvm/sdk").RelayHandler;
  defaultCoordinator?: CoordinatorTarget;
  coordinators?: Record<string, CoordinatorTarget>;
  /**
   * Content-addressed store used to publish/fetch encrypted media blobs. When
   * unset, `sendMedia` and `decryptMediaMessage` throw. The media layer is
   * independent of payload encryption and the coordinator, which never sees
   * blobs. See `spec/applications/encrypted-media.md`.
   */
  mediaStore?: MediaStore;

  /**
   * Multi-device hook (spec/applications/multi-device.md §10): fired after a
   * group operation that advances local state in a way sibling devices must
   * learn about — when a locally-authored Commit is confirmed via self-echo,
   * and when a new group is created. A multi-device client wires this to
   * re-publish its session document so siblings can seed/fast-forward. The
   * callback is fire-and-forget: its result is not awaited and errors are
   * swallowed, so publishing never blocks delivery.
   */
  onLocalStateAdvance?: () => void | Promise<void>;
}

export interface SessionStatus {
  stablePubkey: string;
  keyPackageCount: number;
  welcomeCount: number;
  groupCount: number;
}

export interface StoredKeyPackage {
  alias: string;
  keyPackage: KeyPackage;
  privateKeyPackage: PrivateKeyPackage;
  keyPackageRef: string;
  keyPackageBase64: string;
  isLastResort: boolean;
  publishedAt?: number;
  consumed: boolean;
}

export interface KeyPackageSummary {
  alias?: string;
  stablePubkey: string;
  keyPackageRef: string;
  isLastResort?: boolean;
  publishedAt?: number;
  consumed?: boolean;
  supportsGroupMetadata: boolean;
}

export interface StoredMessage {
  cursor: number;
  createdAt: number;
  direction: "inbound" | "outbound";
  sender: string;
  id: string;
  kind: UnsignedEvent["kind"];
  tags: UnsignedEvent["tags"];
  content: string;
}

export interface SyncIssue {
  cursor: number;
  createdAt: number;
  detail: string;
}

export interface GroupSessionState {
  alias: string;
  coordinatorKey: string;
  state: ClientState;
  metadata?: CordnGroupMetadata;
  status: "active" | "removed";
  removedAtCursor?: number;
  lastCursor: number;
  fetchCursor: number;
  messages: StoredMessage[];
  syncIssues: SyncIssue[];
}

export interface CreateGroupOptions {
  groupId?: string;
  keyPackageAlias?: string;
  metadata?: CordnGroupMetadata;
  coordinatorKey?: string;
}

export interface ConversationView {
  synced: StoredMessage[];
  messages: StoredMessage[];
}

export interface StoredWelcome extends PendingWelcome {
  coordinatorKey?: string;
}
