import type { ClientState, KeyPackage, PrivateKeyPackage } from "ts-mls";
import type { UnsignedEvent } from "nostr-tools";

import type { PendingWelcome } from "@cordn/core";
import type { TransportEncryption } from "./coordinatorClient.ts";
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
  /** Coordinator request transport; see {@link TransportEncryption}. Default "disabled". */
  transportEncryption?: TransportEncryption;
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
  /**
   * Coordinator public keys this key package was published to — the
   * per-coordinator publish markers (spec §4.2
   * `lastResortKeyPackage.coordinators`), replicated through the meta
   * document and restored on a linked device (spec §11.5).
   */
  coordinators?: string[];
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
  /**
   * Identity of the group document this state was adopted from — or that was
   * published from it (spec §10): the document's content address and publish
   * cursor, and the epoch fingerprint of the state it carried. Set on
   * seed/fast-forward/fork-resolve and on publish; the document-rank fallback
   * ranks against it.
   */
  appliedDocument?: { address: string; cursor: number; fingerprint?: string };
  /**
   * Epoch fingerprints (spec §10 detection: `epoch`, `treeHash`,
   * `confirmedTranscriptHash` of the GroupContext, hex) of the states this
   * device has held, keyed by epoch. What a document's `prev` chain is compared
   * against to tell an advance on our branch from a fork that moved on.
   */
  epochFingerprints?: Record<string, string>;
  /**
   * Which side of a shared-leaf race this device's state is on (spec §10 step
   * 1, coordinator order), learned right after posting a Commit by replaying
   * what the coordinator stored before it: `live` — no competing Commit from
   * the shared leaf preceded ours at the base epoch, so the group applied
   * ours; `dead` — one did, so the group applied the sibling's and this state
   * is on a branch nobody else follows until a document of theirs is adopted.
   * Cleared whenever a document is adopted.
   */
  branch?: { kind: "live" | "dead"; sinceEpoch: string };
  /**
   * The last Commit from this device's own shared leaf that ingestion skipped
   * (a sibling's, spec §10), at the epoch it was skipped in. A Commit posted
   * from that same epoch afterwards lost the race to it.
   */
  skippedSiblingCommit?: { epoch: string; cursor: number };
  /**
   * The state right after this device's own Commit produced the current epoch,
   * at that Commit's stream cursor — the epoch's commit point (spec §8.5 gen-0
   * state). Published ahead of the live document, once, when the live state
   * has moved past it, so siblings can open what arrived in between and the
   * §10 fallback can rank branches by where their Commits landed.
   */
  commitPoint?: {
    epoch: string;
    cursor: number;
    clientState: string;
    published?: boolean;
  };
  /**
   * The fork decision recorded for the current epoch (spec §10): the winning
   * branch's fingerprint and what decided it. A decision from evidence is not
   * overturned by the document-rank fallback alone.
   */
  forkDecision?: {
    epoch: string;
    fingerprint: string;
    by: "coordinator-order" | "third-party" | "rank";
  };
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
