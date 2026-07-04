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
 * `spec/03.md`. The blob store is injected (`FileMediaStore` in tests, Blossom
 * in production). The seal is confidentiality-only; authenticity is provided
 * by the tip — a sealed, owner-signed inner Nostr event that points at the
 * document address (spec §6). The tip transport is out of scope here.
 */
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import { nip44 } from "nostr-tools";
import {
  clientStateDecoder,
  clientStateEncoder,
  encode,
  type ClientState,
} from "ts-mls";
import { decodeBase64, encodeBase64 } from "./utils/mlsBase.ts";
import type { MediaStore } from "./mediaStore.ts";
import type { GroupSessionState } from "./sessionState.ts";

export const MULTI_DEVICE_SCHEMA_VERSION = 1;

/**
 * Last published document address per owner, so consecutive publishes form a
 * `prev` chain (spec §4). ponytail: process-local; a device that restarts
 * recovers the chain root by reading the current tip on startup (the chain is
 * self-describing — each doc's `prev` is the prior address). A caller MAY pass
 * `prev` explicitly to override (e.g. to force a fresh chain root).
 */
const lastPublishedTip = new Map<string, string>();

export interface SessionGroupEntry {
  gid: string;
  coordinator: string;
  /** Base64 of `encode(clientStateEncoder, state)`. Sole carrier of presentation
   * metadata (the `CordnGroupMetadata` GroupContext extension, spec/01). */
  clientState: string;
  /** Writer's last-processed delivery cursor for this `gid`. */
  cursor: number;
}

/**
 * Tombstone (spec §4 `removed[]`): records that the identity stopped tracking
 * `gid` when the group was at MLS `epoch`. `epoch` is a JSON number (MLS
 * epochs are small); compared as `BigInt` against `groupContext.epoch`.
 */
export interface SessionTombstone {
  gid: string;
  epoch: number;
}

export interface SessionDocument {
  schemaVersion: typeof MULTI_DEVICE_SCHEMA_VERSION;
  issuedAt: number;
  prev?: string;
  groups: SessionGroupEntry[];
  removed?: SessionTombstone[];
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
  listGroups(): GroupSessionState[];
  deriveGroupId(state: ClientState): string;
  /**
   * Apply one document entry: seed a missing group, fast-forward a present
   * group to a strictly newer epoch, or skip (advisory). Returns the outcome.
   */
  applyDocumentEntry(entry: SessionGroupEntry): Promise<ApplyDocumentOutcome>;
  /**
   * Apply one tombstone (spec §8 case 4): drop a local group whose epoch is
   * ≤ the tombstone epoch; ignore a stale tombstone or one for an unknown
   * group. Returns "dropped" if a local group was removed, else "ignored".
   */
  applyDocumentTombstone(
    tombstone: SessionTombstone,
  ): Promise<"dropped" | "ignored">;
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
    Buffer.from(privateKeyHex, "hex"),
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
    Buffer.from(privateKeyHex, "hex"),
    ownerPubkey,
  );
  const plaintext = nip44.decrypt(sealedPayload, conversationKey);
  const doc = JSON.parse(plaintext) as SessionDocument;

  if (doc.schemaVersion !== MULTI_DEVICE_SCHEMA_VERSION) {
    throw new MultiDeviceError(
      `Unsupported multi-device schema version: ${doc.schemaVersion}`,
    );
  }
  // Authenticity lives in the tip (a sealed owner-signed inner event, spec §6),
  // not in the document: the seal is confidentiality-only (spec §7).
  return doc;
}

// ---------------------------------------------------------------------------
// Document construction
// ---------------------------------------------------------------------------

export interface GroupSnapshotInput {
  gid: string;
  state: ClientState;
  coordinatorKey: string;
  fetchCursor: number;
}

export function buildSessionDocument(params: {
  groups: GroupSnapshotInput[];
  prev?: string;
  removed?: SessionTombstone[];
}): SessionDocument {
  return {
    schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
    issuedAt: Date.now(),
    prev: params.prev,
    groups: params.groups.map((group) => ({
      gid: group.gid,
      coordinator: group.coordinatorKey,
      clientState: encodeBase64(encode(clientStateEncoder, group.state)),
      cursor: group.fetchCursor,
    })),
    removed: params.removed,
  };
}

// ---------------------------------------------------------------------------
// High-level publish / pull / reconcile
// ---------------------------------------------------------------------------

export interface PublishResult {
  /** `sha256` of the sealed payload — the content address / tip value. */
  address: string;
  /** Store URL the blob was published at. */
  url: string;
}

export async function publishCurrentSession(params: {
  session: MultiDeviceSessionView;
  mediaStore: MediaStore;
  prev?: string;
  /**
   * Tombstones to carry in the published `removed` (spec §10.5 union): the
   * device's own new tombstones plus any it adopted from the reconciled tip.
   * The caller composes this; the session does not retain tombstone state.
   */
  removed?: SessionTombstone[];
}): Promise<PublishResult> {
  const { session } = params;
  // Auto-chain `prev` (spec §4): the last address this owner published,
  // unless the caller passes one explicitly. Lets the catch-up chain
  // (spec §8.5) form without the caller tracking state.
  const prev = params.prev ?? lastPublishedTip.get(session.stablePubkey);
  const document = buildSessionDocument({
    prev,
    removed: params.removed,
    groups: session.listGroups().map((group) => ({
      gid: session.deriveGroupId(group.state),
      state: group.state,
      coordinatorKey: group.coordinatorKey,
      fetchCursor: group.fetchCursor,
    })),
  });
  // The seal is confidentiality-only (spec §7); authenticity is provided by
  // the tip's sealed owner-signed inner event (spec §6), not by the document.
  const sealed = sealDocument(
    document,
    session.privateKey,
    session.stablePubkey,
  );
  const blob = Buffer.from(sealed, "utf8");
  const url = await params.mediaStore.publish(blob);
  const address = documentAddress(sealed);
  lastPublishedTip.set(session.stablePubkey, address);
  return { address, url };
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
  dropped: SessionTombstone[];
  ignored: SessionTombstone[];
}> {
  const seeded: SessionGroupEntry[] = [];
  const fastForwarded: SessionGroupEntry[] = [];
  const skipped: SessionGroupEntry[] = [];
  const dropped: SessionTombstone[] = [];
  const ignored: SessionTombstone[] = [];

  for (const entry of document.groups) {
    const outcome = await session.applyDocumentEntry(entry);
    if (outcome === "seeded") seeded.push(entry);
    else if (outcome === "fast-forwarded") fastForwarded.push(entry);
    else skipped.push(entry);
  }

  // Tombstones are processed AFTER groups so a malformed doc that violates the
  // §4 XOR rule still resolves removal-wins on ties (§8). For well-formed docs
  // (XOR) the order is irrelevant. ponytail: no device-local tombstone memory
  // — a tombstone for an unknown group is carried forward by the caller via
  // the published union (§10.5); case 7 (refuse to re-seed from a stale peer
  // that blind-pushes the group as present) is enforced by the §10.5
  // reconcile-before-push discipline, not by a local denylist.
  for (const tombstone of document.removed ?? []) {
    const outcome = await session.applyDocumentTombstone(tombstone);
    if (outcome === "dropped") dropped.push(tombstone);
    else ignored.push(tombstone);
  }

  return { seeded, fastForwarded, skipped, dropped, ignored };
}

// ---------------------------------------------------------------------------
// Chained catch-up (spec §8.5)
// ---------------------------------------------------------------------------

export interface ChainStep {
  epoch: bigint;
  /** Base64 ClientState for this epoch (spec §4 `groups[].clientState`). */
  clientState: string;
  /**
   * Writer's cursor at the moment this epoch's document was published — the
   * epoch boundary used to partition the message gap during catch-up.
   */
  cursor: number;
  /** Content address of the document this step was read from. */
  address: string;
}

/**
 * Walk the `prev` chain (spec §4) backward from the tip, collecting one
 * `ClientState` per epoch strictly newer than `localEpoch` for `groupId`.
 *
 * Authenticity is transitive: the tip transport endorses the tip address
 * (spec §6), each document commits to the next-older address via `prev`, and
 * `pullSessionDocument` re-verifies `sha256(blob) == address` at every hop —
 * so a blob the owner did not author cannot be reached through the chain.
 *
 * One step per epoch, keeping the OLDEST document for that epoch (smallest
 * cursor = published right after the epoch's Commit, ratchet at generation 0).
 * A newer same-epoch document has an advanced ratchet and, by MLS forward
 * secrecy, cannot derive earlier generations — so it could not decrypt that
 * epoch's earlier messages. Sorted ascending by cursor. ponytail: bounded to
 * 1000 hops; a deeper gap should single-snapshot fast-forward (spec §10).
 */
export async function walkSessionChain(params: {
  tipAddress: string;
  groupId: string;
  localEpoch: bigint;
  mediaStore: MediaStore;
  addressToUrl: (address: string) => string;
  privateKeyHex: string;
  ownerPubkey: string;
}): Promise<ChainStep[]> {
  const byEpoch = new Map<bigint, ChainStep>();
  let address: string | undefined = params.tipAddress;
  for (let hop = 0; hop < 1000 && address; hop++) {
    const doc = await pullSessionDocument({
      address,
      mediaStore: params.mediaStore,
      addressToUrl: params.addressToUrl,
      privateKeyHex: params.privateKeyHex,
      ownerPubkey: params.ownerPubkey,
    });
    const entry = doc.groups.find((g) => g.gid === params.groupId);
    if (!entry) break; // group did not exist this far back
    const decoded = clientStateDecoder(decodeBase64(entry.clientState), 0);
    if (!decoded) break;
    const epoch = decoded[0].groupContext.epoch;
    if (epoch <= params.localEpoch) break; // reached local-or-older state
    const existing = byEpoch.get(epoch);
    if (!existing || entry.cursor < existing.cursor) {
      byEpoch.set(epoch, {
        epoch,
        clientState: entry.clientState,
        cursor: entry.cursor,
        address,
      });
    }
    address = doc.prev;
  }
  return [...byEpoch.values()].sort((a, b) => a.cursor - b.cursor);
}
