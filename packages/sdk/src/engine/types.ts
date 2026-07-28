import type {
  AuthenticationService,
  CiphersuiteImpl,
  ClientState,
  IncomingMessageCallback,
  Proposal,
  Welcome,
} from "ts-mls";
import type { CordnError } from "./errors.ts";

/** Recoverable group status (never a thrown crash). See design/cordn-sdk.md #15. */
export type GroupStatus = "active" | "removed" | "poisoned";

/** Publish-before-apply lifecycle. `pendingPublish` = a commit awaiting echo. */
export type GroupLifecycle = "stable" | "pendingPublish";

/**
 * Self-echo match key: the serialized MLS message bytes. The coordinator echoes
 * everything we publish; we match the echo by exact bytes to skip MLS
 * reprocessing (cordn self-echo reconciliation, gotcha #2).
 */
export type MessageRef = Uint8Array;

/** One inbound record fed to `CordnGroupEngine.ingest`. Cursor-agnostic for
 *  advancement (CordnGroup owns that); `cursor` is read-only metadata used
 *  only to record `poisonedAtCursor`. */
export interface InboundRecord {
  /** Serialized MLS framed message bytes (private or public message). */
  message: Uint8Array;
  /** Coordinator cursor of this record (optional metadata). */
  cursor?: number;
}

export type SendIntent =
  | {
      kind: "application";
      plaintext: Uint8Array;
      /** Opaque MLS authenticated data (cordn carries the sender pubkey here). */
      authenticatedData?: Uint8Array;
    }
  | { kind: "proposal"; proposal: Proposal }
  | { kind: "commit"; actions?: ProposalAction[] }
  | { kind: "selfUpdate" };

/** Context handed to a {@link ProposalAction} at commit time (current state). */
export interface ProposalContext {
  ciphersuite: CiphersuiteImpl;
  state: ClientState;
  /** Local stable pubkey, used by builders that guard self-removal. */
  localStablePubkey?: string;
}

/**
 * Composable proposal builder, resolved against the group's state at commit
 * time (inside the serialized turn). Decouples proposal construction from the
 * group and enables batched commits (`commit([addBob, addCarol])`).
 */
export type ProposalAction<T extends Proposal = Proposal> = (
  ctx: ProposalContext,
) => Promise<T> | T;

export type OutboundEffect =
  | { kind: "publish"; message: Uint8Array; ref: MessageRef }
  | {
      kind: "storeWelcome";
      targetPubkey: string;
      welcome: Welcome;
      keyPackageRef: string;
      /** Filled by the client layer (cursor is a transport concern). */
      afterCursor?: number;
    };

export interface SendResult {
  ref: MessageRef;
  effects: OutboundEffect[];
}

/**
 * Structured ingest disposition — the typed replacement for ts-mls error
 * string-matching. One is yielded per inbound record.
 */
export type IngestDisposition =
  /** An application message was decrypted and delivered, or a commit/proposal was applied. */
  | "processed"
  /** A benign former-epoch / stale-generation / undecryptable soft error; advance and continue. */
  | "deferred"
  /** Matched a message we published (own pending commit or app-message echo); skipped MLS reprocessing. */
  | "selfEcho"
  /** An inbound commit removed the local member; `status` is now `"removed"`. */
  | "removed"
  /** Bytes are not a decodable MLS framed message (genuine garbage). */
  | "unreadable"
  /** The admin-authorization callback rejected an inbound commit/proposal. */
  | "rejectedByPolicy";

export interface IngestResult {
  /** The inbound bytes, echoed so the caller can map back to its cursor. */
  message: Uint8Array;
  disposition: IngestDisposition;
  /** Plaintext, present when disposition is `"processed"` for an application message. */
  applicationMessage?: Uint8Array;
  /** MLS authenticated data, present when disposition is `"processed"` for an application message. */
  authenticatedData?: Uint8Array;
  /** Effects produced while processing (e.g. `storeWelcome` on self-echo confirmation of an add). */
  effects?: OutboundEffect[];
  /** The classified error, present on unhealthy dispositions (`deferred`/`removed`/`unreadable`). */
  error?: CordnError;
}

export interface CordnGroupEngineOptions {
  ciphersuite: CiphersuiteImpl;
  /**
   * MLS authentication service. Defaults to `unsafeTestingAuthenticationService`
   * — cordn relies on transport-level Nostr signatures for caller identity
   * (spec §7–8), so the MLS auth service trusts BasicCredentials.
   */
  authService?: AuthenticationService;
  /** Local stable pubkey, used to detect local-member removal. */
  localStablePubkey?: string;
  /** Admin-authorization callback for inbound commits/proposals. */
  adminPolicy?: IncomingMessageCallback;
  /** Initial lifecycle (default `"stable"`). */
  lifecycle?: GroupLifecycle;
}

/** Serialized form of a pending epoch operation (publish-before-apply). */
export interface SerializedAddTarget {
  targetPubkey: string;
  keyPackageRef: string;
}
export interface SerializedPendingOp {
  /** base64 of the commit message — the `pending` Map key. */
  refKey: string;
  kind: "add" | "other";
  prevState: Uint8Array;
  welcome?: Uint8Array;
  /** Present for `add` commits — one per added member (the welcome covers all). */
  targets?: SerializedAddTarget[];
}

/** Engine state snapshot for persistence + recovery. See `engine.serialize()`. */
export interface SerializedEngineState {
  state: Uint8Array;
  lifecycle: GroupLifecycle;
  status: GroupStatus;
  poisonedAtCursor?: number;
  pending: SerializedPendingOp[];
  sentRefs: string[];
}

export type { ClientState };
