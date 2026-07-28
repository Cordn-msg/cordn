/**
 * Multi-device synchronization (see `spec/applications/multi-device.md`).
 *
 * Two sealed, content-addressed JSON document types: one *group document* per
 * live group (that group's `ClientState` + cursor, linked by a per-`gid` `prev`
 * chain), and one *meta document* per identity (the account's last-resort key
 * package + the set of soft-delete tombstones; no chain). Each is sealed to the
 * owner npub with NIP-44 and addressed by `sha256` of the sealed blob. The tip
 * (spec §6) advertises every live group document plus the meta document; that
 * transport lives in `nostrTipStore.ts`.
 *
 * The coordinator is unchanged (spec/03.md). Documents carry group state only
 * (no `nsec`, no messages). The seal is confidentiality-only (spec §7);
 * authenticity is provided by the tip's sealed owner-signed inner event (§6).
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

export class MultiDeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiDeviceError";
  }
}

// ---------------------------------------------------------------------------
// Document shapes (spec §4)
// ---------------------------------------------------------------------------

/**
 * Tombstone (spec §4.2 `removed[]`): the identity stopped tracking `gid` when
 * the group was at MLS `epoch`. `epoch` is a JSON number (MLS epochs are
 * small); compared as `BigInt` against `groupContext.epoch`.
 */
export interface Tombstone {
  gid: string;
  epoch: number;
}

/**
 * Last-resort key package entry (spec §4.2). Both fields are the base64 TLS
 * wire form (RFC 9420 §3) — the only MLS serialization.
 */
export interface LastResortKeyPackageEntry {
  keyPackage: string;
  privateKeyPackage: string;
}

/**
 * One group document (spec §4.1): one per live group, per epoch. `prev` chains
 * per `gid`. `clientState` (base64 TLS) is the sole carrier of presentation
 * state — `CordnGroupMetadata` (spec/01) is a GroupContext extension inside it.
 */
export interface GroupDocument {
  schemaVersion: typeof MULTI_DEVICE_SCHEMA_VERSION;
  type: "group";
  gid: string;
  coordinator: string;
  issuedAt: number;
  prev?: string;
  clientState: string;
  cursor: number;
}

/**
 * One meta document per identity (spec §4.2): a current-state set with NO
 * `prev` chain. Carries the account's last-resort key package and tombstones.
 */
export interface MetaDocument {
  schemaVersion: typeof MULTI_DEVICE_SCHEMA_VERSION;
  type: "meta";
  issuedAt: number;
  lastResortKeyPackage?: LastResortKeyPackageEntry;
  removed?: Tombstone[];
}

export type MultiDeviceDocument = GroupDocument | MetaDocument;

// ---------------------------------------------------------------------------
// Session view (narrow shape CliSession satisfies structurally)
// ---------------------------------------------------------------------------

export type ApplyDocumentOutcome = "seeded" | "fast-forwarded" | "skipped";

export interface MultiDeviceSessionView {
  readonly stablePubkey: string;
  readonly privateKey: string;
  listGroups(): GroupSessionState[];
  deriveGroupId(state: ClientState): string;
  /**
   * Seed a missing group, fast-forward a present group to a strictly newer
   * epoch, or skip (advisory). The newer-epoch check is the rollback defense
   * (spec §8). A sibling device's Commit cannot be ingested via the stream
   * (shared leaf's UpdatePath invalidates this device's keys), so the new
   * private keys must travel in the document (spec §10).
   */
  applyDocumentEntry(doc: GroupDocument): Promise<ApplyDocumentOutcome>;
  /**
   * Spec §8 removal: drop a local group whose epoch is ≤ the tombstone epoch;
   * ignore a stale tombstone (local epoch higher) or one for an unknown group.
   */
  applyDocumentTombstone(tombstone: Tombstone): Promise<"dropped" | "ignored">;
  /** Load the account's last-resort key package from the meta document (§11.5). */
  loadLastResortKeyPackage(entry: LastResortKeyPackageEntry): Promise<boolean>;
  /** The account's currently-published last-resort key package, if any. */
  getLastResortKeyPackage(): LastResortKeyPackageEntry | undefined;
}

// ---------------------------------------------------------------------------
// Content addressing + sealing (spec §5, §6, §7)
// ---------------------------------------------------------------------------

/** `sha256` of the sealed payload's UTF-8 bytes, lowercase hex. Spec §6. */
export function documentAddress(sealedPayload: string): string {
  return createHash("sha256")
    .update(Buffer.from(sealedPayload, "utf8"))
    .digest("hex");
}

/** NIP-44 v2 encryption to the owner's own npub. Confidentiality-only (§7). */
export function sealDocument(
  doc: MultiDeviceDocument,
  privateKeyHex: string,
  ownerPubkey: string,
): string {
  const conversationKey = nip44.getConversationKey(
    Buffer.from(privateKeyHex, "hex"),
    ownerPubkey,
  );
  return nip44.encrypt(JSON.stringify(doc), conversationKey);
}

/** Decrypt and validate a sealed document. Dispatches on `type`. Spec §7. */
export function openDocument(
  sealedPayload: string,
  privateKeyHex: string,
  ownerPubkey: string,
): MultiDeviceDocument {
  const conversationKey = nip44.getConversationKey(
    Buffer.from(privateKeyHex, "hex"),
    ownerPubkey,
  );
  const plaintext = nip44.decrypt(sealedPayload, conversationKey);
  const doc = JSON.parse(plaintext) as MultiDeviceDocument;
  if (doc.schemaVersion !== MULTI_DEVICE_SCHEMA_VERSION) {
    throw new MultiDeviceError(
      `Unsupported multi-device schema version: ${doc.schemaVersion}`,
    );
  }
  // Authenticity lives in the tip (a sealed owner-signed inner event, §6), not
  // in the document: the seal is confidentiality-only (§7).
  if (doc.type !== "group" && doc.type !== "meta") {
    throw new MultiDeviceError(
      `Unknown document type: ${String((doc as { type?: string }).type)}`,
    );
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Document construction (spec §4.1, §4.2)
// ---------------------------------------------------------------------------

export interface GroupDocumentInput {
  gid: string;
  state: ClientState;
  coordinatorKey: string;
  fetchCursor: number;
}

function buildGroupDocument(
  input: GroupDocumentInput,
  prev?: string,
): GroupDocument {
  return {
    schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
    type: "group",
    gid: input.gid,
    coordinator: input.coordinatorKey,
    issuedAt: Date.now(),
    prev,
    clientState: encodeBase64(encode(clientStateEncoder, input.state)),
    cursor: input.fetchCursor,
  };
}

function buildMetaDocument(params: {
  lastResortKeyPackage?: LastResortKeyPackageEntry;
  removed?: Tombstone[];
}): MetaDocument {
  return {
    schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
    type: "meta",
    issuedAt: Date.now(),
    lastResortKeyPackage: params.lastResortKeyPackage,
    removed: params.removed,
  };
}

// ---------------------------------------------------------------------------
// Per-gid prev chain root (process-local; spec §4.1)
// ---------------------------------------------------------------------------

/**
 * Last published group-document address per (owner, `gid`), so consecutive
 * publishes of the SAME group extend its `prev` chain (spec §4.1). ponytail:
 * process-local — sufficient for the test-driven publish flow (one process).
 * A restarting process loses the root and the next publish starts a new chain
 * (a `prev` gap); a caller that needs continuity reads the current tip and
 * passes `prev` explicitly (REPL startup wiring, not implemented here).
 */
const lastPublishedGroupTip = new Map<string, string>();

function groupChainKey(ownerPubkey: string, gid: string): string {
  return `${ownerPubkey}:${gid}`;
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

/**
 * Publish one group document, extending that group's per-`gid` `prev` chain
 * (spec §10.5: a group change republishes only that group's document).
 */
export async function publishGroupDocument(params: {
  session: MultiDeviceSessionView;
  mediaStore: MediaStore;
  gid: string;
  prev?: string;
}): Promise<PublishResult> {
  const { session, gid } = params;
  const group = session
    .listGroups()
    .find((g) => session.deriveGroupId(g.state) === gid);
  if (!group) {
    throw new MultiDeviceError(`No local group for gid ${gid}`);
  }
  const prev =
    params.prev ??
    lastPublishedGroupTip.get(groupChainKey(session.stablePubkey, gid));
  const doc = buildGroupDocument(
    {
      gid,
      state: group.state,
      coordinatorKey: group.coordinatorKey,
      fetchCursor: group.fetchCursor,
    },
    prev,
  );
  const sealed = sealDocument(doc, session.privateKey, session.stablePubkey);
  const blob = Buffer.from(sealed, "utf8");
  const url = await params.mediaStore.publish(blob);
  const address = documentAddress(sealed);
  lastPublishedGroupTip.set(groupChainKey(session.stablePubkey, gid), address);
  return { address, url };
}

/**
 * Publish the meta document (spec §4.2). It is a current-state set with no
 * `prev`; a tombstone or key-package change republishes only this document and
 * updates only its `meta` `x` tag in the tip (§10.5).
 */
export async function publishMetaDocument(params: {
  session: MultiDeviceSessionView;
  mediaStore: MediaStore;
  removed?: Tombstone[];
  /** Defaults to the session's own last-resort key package. */
  lastResortKeyPackage?: LastResortKeyPackageEntry;
}): Promise<PublishResult> {
  const { session } = params;
  const doc = buildMetaDocument({
    lastResortKeyPackage:
      params.lastResortKeyPackage ?? session.getLastResortKeyPackage(),
    removed: params.removed,
  });
  const sealed = sealDocument(doc, session.privateKey, session.stablePubkey);
  const blob = Buffer.from(sealed, "utf8");
  const url = await params.mediaStore.publish(blob);
  return { address: documentAddress(sealed), url };
}

/**
 * Fetch a document by its content address. `addressToUrl` maps the address to
 * the store's URL scheme. Re-verifies `sha256(blob) == address` (spec §6).
 */
export async function pullDocument(params: {
  address: string;
  mediaStore: MediaStore;
  addressToUrl: (address: string) => string;
  privateKeyHex: string;
  ownerPubkey: string;
}): Promise<MultiDeviceDocument> {
  const url = params.addressToUrl(params.address);
  const blob = await params.mediaStore.fetch(url);
  const sealed = Buffer.from(blob).toString("utf8");
  if (documentAddress(sealed) !== params.address) {
    throw new MultiDeviceError(
      "Document address mismatch: fetched blob does not match the advertised tip",
    );
  }
  return openDocument(sealed, params.privateKeyHex, params.ownerPubkey);
}

/**
 * Seed/fast-forward/skip one group document against local state (spec §8).
 */
export async function reconcileGroupDocument(
  session: MultiDeviceSessionView,
  doc: GroupDocument,
): Promise<ApplyDocumentOutcome> {
  return session.applyDocumentEntry(doc);
}

/**
 * Apply a meta document: drop local groups named in tombstones (§8), and load
 * the account's last-resort key package if present (§11.5). Tombstones are the
 * caller's responsibility to order after group reconciliation (§8 ties to
 * removal); for a well-formed meta doc the order is irrelevant.
 */
export async function reconcileMetaDocument(
  session: MultiDeviceSessionView,
  doc: MetaDocument,
): Promise<{
  dropped: Tombstone[];
  ignored: Tombstone[];
  keyPackageLoaded: boolean;
}> {
  const dropped: Tombstone[] = [];
  const ignored: Tombstone[] = [];
  for (const tombstone of doc.removed ?? []) {
    const outcome = await session.applyDocumentTombstone(tombstone);
    // ponytail: no device-local tombstone memory — a tombstone for an unknown
    // group is carried forward by the caller via the published union (§10.5);
    // the §10.5 reconcile-before-push discipline keeps a stale peer from
    // resurrecting it by blind-pushing the group as present.
    (outcome === "dropped" ? dropped : ignored).push(tombstone);
  }
  const keyPackageLoaded = doc.lastResortKeyPackage
    ? await session.loadLastResortKeyPackage(doc.lastResortKeyPackage)
    : false;
  return { dropped, ignored, keyPackageLoaded };
}

// ---------------------------------------------------------------------------
// Per-group chained catch-up (spec §8.5)
// ---------------------------------------------------------------------------

export interface ChainStep {
  epoch: bigint;
  /** Base64 ClientState for this epoch (spec §4.1 `clientState`). */
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
 * Walk one group's `prev` chain (spec §4.1) backward from the tip, collecting
 * one `ClientState` per epoch strictly newer than `localEpoch` for `groupId`.
 *
 * Authenticity is transitive: the tip transport endorses the tip address
 * (§6), each document commits to the next-older address via `prev`, and
 * `pullDocument` re-verifies `sha256(blob) == address` at every hop — so a
 * blob the owner did not author cannot be reached through the chain.
 *
 * One step per epoch, keeping the OLDEST document for that epoch (smallest
 * cursor = published right after that epoch's Commit, ratchet at generation 0).
 * A newer same-epoch document has an advanced ratchet and cannot, by forward
 * secrecy, derive earlier generations. Sorted ascending by cursor.
 * ponytail: bounded to 1000 hops; a deeper gap should single-snapshot
 * fast-forward (spec §10).
 */
export async function walkGroupChain(params: {
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
    const doc = await pullDocument({
      address,
      mediaStore: params.mediaStore,
      addressToUrl: params.addressToUrl,
      privateKeyHex: params.privateKeyHex,
      ownerPubkey: params.ownerPubkey,
    });
    // The chain is per-gid: stop at a meta doc or a different group's doc.
    if (doc.type !== "group" || doc.gid !== params.groupId) break;
    const decoded = clientStateDecoder(decodeBase64(doc.clientState), 0);
    if (!decoded) break;
    const epoch = decoded[0].groupContext.epoch;
    if (epoch <= params.localEpoch) break; // reached local-or-older state
    const existing = byEpoch.get(epoch);
    if (!existing || doc.cursor < existing.cursor) {
      byEpoch.set(epoch, {
        epoch,
        clientState: doc.clientState,
        cursor: doc.cursor,
        address,
      });
    }
    address = doc.prev;
  }
  return [...byEpoch.values()].sort((a, b) => a.cursor - b.cursor);
}
