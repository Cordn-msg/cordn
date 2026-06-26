import type { ClientState, KeyPackage, PrivateKeyPackage } from "ts-mls";
import type { UnsignedEvent } from "nostr-tools";

import type { PendingWelcome } from "../contracts/index.ts";
import type { CoordinatorTarget } from "./coordinatorRegistry.ts";
import type { CordnGroupMetadata } from "./groupMetadata.ts";

export interface CliSessionOptions {
  privateKey?: string;
  serverPubkey?: string;
  relays?: string[];
  relayHandler?: import("@contextvm/sdk").RelayHandler;
  defaultCoordinator?: CoordinatorTarget;
  coordinators?: Record<string, CoordinatorTarget>;
  /**
   * Encrypt outbound group payloads (Marmot-style) before posting.
   *
   * - `false` (default): raw MLS bytes are posted so clients that have
   *   not upgraded can still read messages. Use during the staged
   *   rollout while the reader population catches up to the `encrypted`
   *   flag.
   * - `true`: payloads are encrypted; only clients holding the current
   *   epoch's exporter secret can decrypt.
   *
   * The read path always handles both encrypted and legacy shapes
   * regardless of this setting, so mixed-version groups interoperate.
   */
  encryptOutbound?: boolean;
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
