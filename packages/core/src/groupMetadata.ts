/**
 * The cordn group metadata extension (spec/01.md §4) and its first trailing
 * field, coordinator_routing (coordinator-handoff.md §4), plus the pure
 * normalization and admin-policy helpers every client shares.
 *
 * This is the single definition of these wire forms: the CLI and the web
 * client both consume it so their codecs and normalization cannot drift.
 */
import {
  defaultCapabilities,
  makeCustomExtension,
  type Capabilities,
  type ClientState,
  type GroupContextExtension,
} from "ts-mls";

import { APP_DATA_DICTIONARY_EXTENSION_TYPE } from "./lastResortKeyPackage.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const CORDN_GROUP_METADATA_EXTENSION_TYPE = 0xc04d;

export interface CoordinatorLocator {
  pubkey: string;
  relayUrls: string[];
}

export interface CordnCoordinatorRouting {
  active: CoordinatorLocator;
  fallbacks: CoordinatorLocator[];
  /** Envelope `id` values the group has confirmed — the accumulated cut
   *  (coordinator-handoff.md §7.1): one handoff committer's tip set at a time. */
  boundaryTips: string[];
}

export interface CordnGroupMetadata {
  name: string;
  description?: string;
  adminPubkeys?: string[];
  icon?: string;
  imageUrl?: string;
  /** Trailing field: coordinator routing state (coordinator-handoff.md §4). */
  coordinatorRouting?: CordnCoordinatorRouting;
}

interface NormalizedCordnGroupMetadata {
  version: number;
  name: string;
  description: string;
  adminPubkeys: string[];
  icon: string;
  imageUrl: string;
  coordinatorRouting?: CordnCoordinatorRouting;
}

const ENVELOPE_ID = /^[0-9a-f]{64}$/;
const PUBKEY = /^[0-9a-f]{64}$/;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(parts.flatMap((part) => Array.from(part)));
}

function encodeUint16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`Value out of uint16 range: ${value}`);
  }

  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function decodeUint16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) {
    throw new Error("Unexpected end of metadata while reading uint16");
  }

  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function encodeField(bytes: Uint8Array): Uint8Array {
  return new Uint8Array([...encodeUint16(bytes.length), ...bytes]);
}

function decodeField(bytes: Uint8Array, offset: number): [Uint8Array, number] {
  const length = decodeUint16(bytes, offset);
  const start = offset + 2;
  const end = start + length;

  if (end > bytes.length) {
    throw new Error("Unexpected end of metadata while reading field");
  }

  return [bytes.slice(start, end), end];
}

function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function encodeUtf8(value: string): Uint8Array {
  return encoder.encode(value);
}

// --- normalization (single definition; the per-module copies drifted) -------

export function normalizePubkey(pubkey: string): string {
  const normalized = pubkey.trim().toLowerCase();
  if (!PUBKEY.test(normalized)) {
    throw new Error(`Invalid pubkey: ${pubkey}`);
  }
  return normalized;
}

/** Non-throwing normalizePubkey for peer-controlled values (senders, tags,
 *  member credentials, decoded group metadata): returns '' for invalid input
 *  so hostile or buggy peers cannot crash render or ingestion paths. */
export function safeNormalizePubkey(pubkey: string): string {
  const normalized = pubkey.trim().toLowerCase();
  return PUBKEY.test(normalized) ? normalized : "";
}

function normalizeEnvelopeId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!ENVELOPE_ID.test(normalized)) {
    throw new Error(`Invalid envelope id: ${id}`);
  }
  return normalized;
}

function normalizeAdminPubkeys(adminPubkeys?: string[]): string[] {
  if (!adminPubkeys || adminPubkeys.length === 0) {
    return [];
  }

  // Strict: entries are pubkeys, not hints — a blank or malformed entry is a
  // rejected field, never a silent demotion to an egalitarian admin set.
  const normalized = adminPubkeys.map((value) => normalizePubkey(value));

  // Duplicates are compared after normalization so mixed-case twins of one
  // pubkey are rejected too.
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Group metadata admin pubkeys must not contain duplicates");
  }
  return normalized;
}

function normalizeLocator(locator: CoordinatorLocator): CoordinatorLocator {
  return {
    pubkey: normalizePubkey(locator.pubkey),
    relayUrls: locator.relayUrls.map((url) => {
      const trimmed = url.trim();
      if (!trimmed) {
        throw new Error("Relay URLs must be non-empty");
      }
      return trimmed;
    }),
  };
}

function normalizeCordnGroupMetadata(
  metadata: CordnGroupMetadata,
): NormalizedCordnGroupMetadata {
  if (metadata.name === undefined) {
    throw new Error(
      "Group metadata name is required when metadata is provided",
    );
  }

  return {
    version: 1,
    name: metadata.name.trim(),
    description: (metadata.description ?? "").trim(),
    adminPubkeys: normalizeAdminPubkeys(metadata.adminPubkeys),
    icon: (metadata.icon ?? "").trim(),
    imageUrl: (metadata.imageUrl ?? "").trim(),
    coordinatorRouting: metadata.coordinatorRouting,
  };
}

// --- admin policy (spec/01.md §4: an empty admin set is egalitarian) -------

/** Reads the admin set from (possibly peer-supplied) metadata; invalid
 *  entries are dropped rather than thrown on. */
export function getGroupAdminPubkeys(metadata?: CordnGroupMetadata): string[] {
  return (metadata?.adminPubkeys ?? [])
    .map((value) => safeNormalizePubkey(value))
    .filter((pubkey) => pubkey.length > 0);
}

export function isEgalitarianGroup(metadata?: CordnGroupMetadata): boolean {
  return getGroupAdminPubkeys(metadata).length === 0;
}

export function isGroupAdmin(params: {
  metadata?: CordnGroupMetadata;
  stablePubkey: string;
}): boolean {
  const stablePubkey = normalizePubkey(params.stablePubkey);
  const admins = getGroupAdminPubkeys(params.metadata);

  return admins.length === 0 || admins.includes(stablePubkey);
}

// --- coordinator routing (coordinator-handoff.md §4.1) ---------------------

function encodeAdminPubkeys(adminPubkeys: string[]): Uint8Array {
  return concat(...adminPubkeys.map((value) => hexToBytes(value)));
}

function decodeAdminPubkeys(bytes: Uint8Array): string[] {
  if (bytes.length % 32 !== 0) {
    throw new Error(
      "Group metadata admin_pubkeys length must be a multiple of 32",
    );
  }

  const values: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += 32) {
    values.push(bytesToHex(bytes.slice(offset, offset + 32)));
  }

  // Decode boundary (peer Commits): the hex output is always well-formed, but
  // a hostile payload may repeat entries. Duplicate rejection is encode-path
  // validation of local input — throwing here would abort ingestion for every
  // reader of the Commit, so dedupe instead.
  return [...new Set(values.map((value) => normalizePubkey(value)))];
}

function encodeLocator(locator: CoordinatorLocator): Uint8Array {
  const relays = concat(
    ...locator.relayUrls.map((url) => encodeField(encoder.encode(url))),
  );
  return concat(hexToBytes(locator.pubkey), encodeField(relays));
}

function decodeStrings(bytes: Uint8Array): string[] {
  const values: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [value, next] = decodeField(bytes, offset);
    values.push(decoder.decode(value));
    offset = next;
  }
  return values;
}

function decodeLocator(
  bytes: Uint8Array,
  offset: number,
): [CoordinatorLocator, number] {
  const end = offset + 32;
  if (end > bytes.length) {
    throw new Error(
      "Unexpected end of cordn coordinator routing while reading locator",
    );
  }
  const pubkey = bytesToHex(bytes.slice(offset, end));
  const [relays, next] = decodeField(bytes, end);
  return [normalizeLocator({ pubkey, relayUrls: decodeStrings(relays) }), next];
}

function decodeLocators(bytes: Uint8Array): CoordinatorLocator[] {
  const locators: CoordinatorLocator[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [locator, next] = decodeLocator(bytes, offset);
    locators.push(locator);
    offset = next;
  }
  return locators;
}

export function encodeCordnCoordinatorRouting(
  routing: CordnCoordinatorRouting,
): Uint8Array {
  const fallbacks = routing.fallbacks.map(normalizeLocator);
  const tips = concat(
    ...routing.boundaryTips.map((id) =>
      encodeField(encoder.encode(normalizeEnvelopeId(id))),
    ),
  );

  return concat(
    encodeUint16(1),
    encodeLocator(normalizeLocator(routing.active)),
    encodeField(concat(...fallbacks.map(encodeLocator))),
    encodeField(tips),
  );
}

export function decodeCordnCoordinatorRouting(
  bytes: Uint8Array,
): CordnCoordinatorRouting {
  let offset = 0;
  const version = decodeUint16(bytes, offset);
  offset += 2;

  if (version === 0) {
    throw new Error("Reserved cordn coordinator routing version: 0");
  }

  const [active, afterActive] = decodeLocator(bytes, offset);
  offset = afterActive;
  const [fallbacksBlob, afterFallbacks] = decodeField(bytes, offset);
  offset = afterFallbacks;
  const [tipsBlob, afterTips] = decodeField(bytes, offset);
  offset = afterTips;

  const fallbacks = decodeLocators(fallbacksBlob);

  if (version === 1 && offset !== bytes.length) {
    throw new Error("Unexpected trailing bytes in cordn coordinator routing");
  }

  return {
    active,
    fallbacks,
    boundaryTips: decodeStrings(tipsBlob).map(normalizeEnvelopeId),
  };
}

// --- group metadata (spec/01.md §4) ----------------------------------------

export function encodeCordnGroupMetadata(
  metadata: CordnGroupMetadata,
): Uint8Array {
  const normalized = normalizeCordnGroupMetadata(metadata);

  return new Uint8Array([
    ...encodeUint16(normalized.version),
    ...encodeField(encodeUtf8(normalized.name)),
    ...encodeField(encodeUtf8(normalized.description)),
    ...encodeField(encodeAdminPubkeys(normalized.adminPubkeys)),
    ...encodeField(encodeUtf8(normalized.icon)),
    ...encodeField(encodeUtf8(normalized.imageUrl)),
    // First trailing field: coordinator_routing (coordinator-handoff.md
    // §4.1). Always present so future trailing fields keep their position.
    ...encodeField(
      normalized.coordinatorRouting === undefined
        ? new Uint8Array()
        : encodeCordnCoordinatorRouting(normalized.coordinatorRouting),
    ),
  ]);
}

export function decodeCordnGroupMetadata(
  bytes: Uint8Array,
): CordnGroupMetadata {
  let offset = 0;
  const version = decodeUint16(bytes, offset);
  offset += 2;

  if (version !== 1) {
    throw new Error(`Unsupported cordn group metadata version: ${version}`);
  }

  const [nameBytes, offsetAfterName] = decodeField(bytes, offset);
  const [descriptionBytes, offsetAfterDescription] = decodeField(
    bytes,
    offsetAfterName,
  );
  const [adminPubkeysBytes, offsetAfterAdmins] = decodeField(
    bytes,
    offsetAfterDescription,
  );
  const [iconBytes, offsetAfterIcon] = decodeField(bytes, offsetAfterAdmins);
  const [imageUrlBytes, afterImageUrl] = decodeField(bytes, offsetAfterIcon);

  // The first trailing field is coordinator_routing (coordinator-handoff.md
  // §4.1); further trailing fields come from future versions and are ignored
  // (spec/01.md §4).
  let coordinatorRouting: CordnCoordinatorRouting | undefined;
  if (afterImageUrl < bytes.length) {
    const [routingBytes, afterRouting] = decodeField(bytes, afterImageUrl);
    offset = afterRouting;
    if (routingBytes.length > 0) {
      coordinatorRouting = decodeCordnCoordinatorRouting(routingBytes);
    }
  }

  const adminPubkeys = decodeAdminPubkeys(adminPubkeysBytes);

  return {
    name: decodeUtf8(nameBytes).trim(),
    description: decodeUtf8(descriptionBytes).trim() || undefined,
    adminPubkeys: adminPubkeys.length > 0 ? adminPubkeys : undefined,
    icon: decodeUtf8(iconBytes).trim() || undefined,
    imageUrl: decodeUtf8(imageUrlBytes).trim() || undefined,
    coordinatorRouting,
  };
}

// --- extensions (ts-mls) ---------------------------------------------------

export function makeCordnGroupMetadataExtension(
  metadata: CordnGroupMetadata,
): GroupContextExtension {
  return makeCustomExtension({
    extensionType: CORDN_GROUP_METADATA_EXTENSION_TYPE,
    extensionData: encodeCordnGroupMetadata(metadata),
  });
}

export function getCordnGroupMetadataFromExtensions(
  extensions: readonly GroupContextExtension[],
): CordnGroupMetadata | undefined {
  const extension = extensions.find(
    (candidate) =>
      candidate.extensionType === CORDN_GROUP_METADATA_EXTENSION_TYPE,
  );

  if (!extension) {
    return undefined;
  }

  return decodeCordnGroupMetadata(extension.extensionData as Uint8Array);
}

export function getCordnGroupMetadataExtension(
  state: ClientState,
): CordnGroupMetadata | undefined {
  return getCordnGroupMetadataFromExtensions(state.groupContext.extensions);
}

export function createCordnMetadataCapabilities(): Capabilities {
  const capabilities = defaultCapabilities();

  for (const extensionType of [
    CORDN_GROUP_METADATA_EXTENSION_TYPE,
    APP_DATA_DICTIONARY_EXTENSION_TYPE,
  ]) {
    if (!capabilities.extensions.includes(extensionType)) {
      capabilities.extensions = [...capabilities.extensions, extensionType];
    }
  }

  return capabilities;
}

// --- routing void rule (coordinator-handoff.md §4.4/§14) -------------------

/** A routing update whose new `active` is not a declared fallback of the
 *  previous state is void — the routing change is discarded (the rest of the
 *  metadata still applies). Enforced at every metadata adoption so a later
 *  re-derivation from the group context cannot smuggle it back in. */
export function metadataWithVoidedRouting(
  previous: CordnGroupMetadata | undefined,
  incoming: CordnGroupMetadata | undefined,
): { metadata: CordnGroupMetadata | undefined; voided: boolean } {
  const old = previous?.coordinatorRouting;
  const next = incoming?.coordinatorRouting;
  if (
    old &&
    next &&
    next.active.pubkey !== old.active.pubkey &&
    !old.fallbacks.some((f) => f.pubkey === next.active.pubkey)
  ) {
    return { metadata: { ...incoming, coordinatorRouting: old }, voided: true };
  }
  return { metadata: incoming, voided: false };
}
