/**
 * Multi-device session synchronization (see `spec/applications/multi-device.md`).
 *
 * Devices of one identity share a single MLS leaf per group. This module
 * snapshots a session's per-group `ClientState` and fetch cursor into a sealed
 * *session document*, content-addresses it, and lets another device of the same
 * identity fetch, decrypt, and seed the groups it is missing — then converge
 * via the normal coordinator delivery stream.
 *
 * The document carries group state only (no `nsec`, no messages). It is sealed
 * to the owner's own npub with NIP-44, so any device that can sign as the owner
 * can decrypt. No pairing, pre-shared key, or extra KDF is defined.
 *
 * The coordinator is not involved: it stays content-opaque, as required by
 * `spec/03.md`. The blob store and tip store are injected so tests can run
 * fully in-process (`FileMediaStore` + `InMemoryTipStore`) and production can
 * use Blossom + a Nostr replaceable event.
 */
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import { nip44 } from "nostr-tools";
import { clientStateEncoder, encode, type ClientState } from "ts-mls";
import type { CordnGroupMetadata } from "./groupMetadata.ts";
import { encodeBase64 } from "./utils/mlsBase.ts";
import type { MediaStore } from "./mediaStore.ts";
import type { GroupSessionState } from "./sessionState.ts";

export const MULTI_DEVICE_SCHEMA_VERSION = 1;

export interface SessionGroupEntry {
  gid: string;
  coordinator: string;
  metadata?: CordnGroupMetadata;
  encrypted: boolean;
  /** Base64 of `encode(clientStateEncoder, state)`. */
  clientState: string;
  /** Writer's last-processed delivery cursor for this `gid`. */
  cursor: number;
  status: "active" | "removed";
}

export interface SessionDocument {
  schemaVersion: typeof MULTI_DEVICE_SCHEMA_VERSION;
  ownerPubkey: string;
  issuedAt: number;
  issuedByDevice?: string;
  prev?: string;
  groups: SessionGroupEntry[];
}

export class MultiDeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiDeviceError";
  }
}

/**
 * Narrow view of {@link CliSession} that this module needs. `CliSession`
 * already satisfies it; the interface keeps the module decoupled and testable.
 */
export interface MultiDeviceSessionView {
  readonly stablePubkey: string;
  readonly privateKey: string;
  readonly encryptOutbound: boolean;
  listGroups(): GroupSessionState[];
  deriveGroupId(state: ClientState): string;
  /**
   * Apply one document entry: seed a missing group, fast-forward a present
   * group to a strictly newer epoch, or skip (advisory). Returns the outcome.
   */
  applyDocumentEntry(entry: SessionGroupEntry): Promise<ApplyDocumentOutcome>;
}

export type ApplyDocumentOutcome = "seeded" | "fast-forwarded" | "skipped";

// ---------------------------------------------------------------------------
// Canonical JSON + content addressing + sealing
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON for content-addressing: object members sorted by name,
 * no insignificant whitespace. Sufficient for a stable `sha256` of a document
 * we control end-to-end (writer and reader share this encoder). Not full
 * RFC 8785 — big-number/string-escaping edge cases are irrelevant for the
 * document shape defined here, which is the only thing that is ever addressed.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** `sha256` of the sealed payload's UTF-8 bytes, lowercase hex. Spec §6. */
export function documentAddress(sealedPayload: string): string {
  return createHash("sha256")
    .update(Buffer.from(sealedPayload, "utf8"))
    .digest("hex");
}

/** NIP-44 v2 encryption to the owner's own npub. Spec §7. */
export function sealDocument(
  doc: SessionDocument,
  privateKeyHex: string,
  ownerPubkey: string,
): string {
  const conversationKey = nip44.getConversationKey(
    Uint8Array.from(Buffer.from(privateKeyHex, "hex")),
    ownerPubkey,
  );
  return nip44.encrypt(canonicalJson(doc), conversationKey);
}

/** Decrypt and validate a sealed document. Spec §7. */
export function openDocument(
  sealedPayload: string,
  privateKeyHex: string,
  ownerPubkey: string,
): SessionDocument {
  const conversationKey = nip44.getConversationKey(
    Uint8Array.from(Buffer.from(privateKeyHex, "hex")),
    ownerPubkey,
  );
  const plaintext = nip44.decrypt(sealedPayload, conversationKey);
  const doc = JSON.parse(plaintext) as SessionDocument;

  if (doc.schemaVersion !== MULTI_DEVICE_SCHEMA_VERSION) {
    throw new MultiDeviceError(
      `Unsupported multi-device schema version: ${doc.schemaVersion}`,
    );
  }
  // ponytail: owner check is a cheap guard, not a security boundary — the
  // seal already required the owner nsec to decrypt. It prevents a device
  // from ingesting a document another identity somehow encrypted for it.
  if (doc.ownerPubkey !== ownerPubkey) {
    throw new MultiDeviceError("Document ownerPubkey does not match identity");
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Document construction
// ---------------------------------------------------------------------------

export interface GroupSnapshotInput {
  gid: string;
  state: ClientState;
  coordinatorKey: string;
  metadata?: CordnGroupMetadata;
  fetchCursor: number;
  status: "active" | "removed";
}

export function buildSessionDocument(params: {
  ownerPubkey: string;
  groups: GroupSnapshotInput[];
  issuedByDevice?: string;
  prev?: string;
  encryptedOutbound: boolean;
}): SessionDocument {
  return {
    schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
    ownerPubkey: params.ownerPubkey,
    issuedAt: Date.now(),
    issuedByDevice: params.issuedByDevice,
    prev: params.prev,
    groups: params.groups.map((group) => ({
      gid: group.gid,
      coordinator: group.coordinatorKey,
      metadata: group.metadata,
      encrypted: params.encryptedOutbound,
      clientState: encodeBase64(encode(clientStateEncoder, group.state)),
      cursor: group.fetchCursor,
      status: group.status,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tip store (transport not normative — see spec §6)
// ---------------------------------------------------------------------------

export interface TipStore {
  set(ownerPubkey: string, address: string): Promise<void> | void;
  get(ownerPubkey: string): Promise<string | undefined> | string | undefined;
}

export class InMemoryTipStore implements TipStore {
  private readonly tips = new Map<string, string>();
  set(ownerPubkey: string, address: string): void {
    this.tips.set(ownerPubkey, address);
  }
  get(ownerPubkey: string): string | undefined {
    return this.tips.get(ownerPubkey);
  }
}

// ---------------------------------------------------------------------------
// High-level publish / pull / reconcile
// ---------------------------------------------------------------------------

export interface PublishResult {
  document: SessionDocument;
  /** `sha256` of the sealed payload — the content address / tip value. */
  address: string;
  /** Store URL the blob was published at. */
  url: string;
}

export async function publishCurrentSession(params: {
  session: MultiDeviceSessionView;
  mediaStore: MediaStore;
  deviceLabel?: string;
  prev?: string;
}): Promise<PublishResult> {
  const { session } = params;
  const document = buildSessionDocument({
    ownerPubkey: session.stablePubkey,
    encryptedOutbound: session.encryptOutbound,
    issuedByDevice: params.deviceLabel,
    prev: params.prev,
    groups: session.listGroups().map((group) => ({
      gid: session.deriveGroupId(group.state),
      state: group.state,
      coordinatorKey: group.coordinatorKey,
      metadata: group.metadata,
      fetchCursor: group.fetchCursor,
      status: group.status,
    })),
  });

  const sealed = sealDocument(
    document,
    session.privateKey,
    session.stablePubkey,
  );
  const blob = Buffer.from(sealed, "utf8");
  const url = await params.mediaStore.publish(blob);
  const address = documentAddress(sealed);
  return { document, address, url };
}

/**
 * Fetch a document by its content address. `addressToUrl` maps the address to
 * the store's URL scheme (`media://<sha256>` for `FileMediaStore`; a Blossom
 * client would use `https://<server>/<sha256>`). The tip transport is
 * non-normative; this is the only store-specific seam.
 */
export async function pullSessionDocument(params: {
  address: string;
  mediaStore: MediaStore;
  addressToUrl: (address: string) => string;
  privateKeyHex: string;
  ownerPubkey: string;
}): Promise<SessionDocument> {
  const url = params.addressToUrl(params.address);
  const blob = await params.mediaStore.fetch(url);
  const sealed = Buffer.from(blob).toString("utf8");
  const address = documentAddress(sealed);
  if (address !== params.address) {
    throw new MultiDeviceError(
      "Document address mismatch: fetched blob does not match the advertised tip",
    );
  }
  return openDocument(sealed, params.privateKeyHex, params.ownerPubkey);
}

/**
 * Seed-and-fast-forward reconciliation (spec §8). For each document entry the
 * session either seeds a missing group, fast-forwards a present group to a
 * strictly newer epoch (never a downgrade — that is the rollback defense),
 * or skips it as advisory. Returns the entries per outcome.
 */
export async function reconcileFromDocument(
  session: MultiDeviceSessionView,
  document: SessionDocument,
): Promise<{
  seeded: SessionGroupEntry[];
  fastForwarded: SessionGroupEntry[];
  skipped: SessionGroupEntry[];
}> {
  const seeded: SessionGroupEntry[] = [];
  const fastForwarded: SessionGroupEntry[] = [];
  const skipped: SessionGroupEntry[] = [];

  for (const entry of document.groups) {
    const outcome = await session.applyDocumentEntry(entry);
    if (outcome === "seeded") seeded.push(entry);
    else if (outcome === "fast-forwarded") fastForwarded.push(entry);
    else skipped.push(entry);
  }

  return { seeded, fastForwarded, skipped };
}
