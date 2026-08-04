import { bech32 } from "@scure/base";

/**
 * Bech32 prefix for a cordn group reference. Encoded strings begin with
 * `cordn1`. See `spec/applications/group-ref.md`.
 */
const PREFIX = "cordn";

/** Maximum encoded length in characters, matching the NIP-19 limit. */
const MAX_LENGTH = 5000;

/** Maximum size of the UTF-8 encoding of a `gid`, in bytes. This is the
 *  hard limit of the 1-byte TLV length field shared with NIP-19. */
const MAX_GID_BYTES = 255;

// TLV type identifiers, mirroring NIP-19 roles: type 0 is the primary
// identifier (gid, as naddr carries its identifier), type 1 is a 32-byte
// public key (the coordinator), type 2 is a repeatable relay URL. Relays are
// numbered above the coordinator public key because they are only meaningful
// alongside one.
const TLV_GID = 0;
const TLV_COORDINATOR_PUBKEY = 1;
const TLV_RELAY = 2;

const utf8Encoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Lowercase Nostr hex, 32 bytes (64 chars). This is the canonical form used
 *  throughout cordn for public keys. */
const HEX_PUBKEY = /^[0-9a-f]{64}$/;

/** A bech32-encoded reference to a cordn group. Packages the coordinates a
 *  client needs to discover a group and act on it: the delivery `gid`, an
 *  optional coordinator public key, and optional relay hints. The coordinator
 *  never decodes this; it is a pure client-side interop primitive. */
export interface GroupRef {
  /** Delivery group identifier (`spec/03.md` §2). Opaque to the coordinator;
   *  encoded verbatim as UTF-8. */
  gid: string;
  /** Coordinator public key as lowercase Nostr hex (64 chars / 32 bytes).
   *  Optional, but required when `relays` is non-empty. */
  coordinatorPubkey?: string;
  /** Relay URLs where the coordinator is reachable. Meaningful only when
   *  `coordinatorPubkey` is set. */
  relays?: string[];
}

/**
 * Encode a group reference as a bech32 string beginning with `cordn1`. TLV
 * elements are emitted in descending type order to match the NIP-19 reference
 * encoding; `decodeGroupRef` accepts any order.
 */
export function encodeGroupRef(ref: GroupRef): string {
  const gidBytes = utf8Encoder.encode(ref.gid);
  if (gidBytes.length === 0) {
    throw new Error("Invalid group reference: gid must be non-empty");
  }
  if (gidBytes.length > MAX_GID_BYTES) {
    throw new Error(
      `Invalid group reference: gid exceeds ${MAX_GID_BYTES} bytes`,
    );
  }

  const hasPubkey = ref.coordinatorPubkey !== undefined;
  if (hasPubkey && !HEX_PUBKEY.test(ref.coordinatorPubkey!)) {
    throw new Error(
      "Invalid group reference: coordinatorPubkey must be 64 lowercase hex chars (32 bytes)",
    );
  }
  const pubkeyBytes = hasPubkey
    ? Uint8Array.from(Buffer.from(ref.coordinatorPubkey!, "hex"))
    : undefined;

  const relays = ref.relays ?? [];
  if (relays.length > 0 && pubkeyBytes === undefined) {
    throw new Error(
      "Invalid group reference: relays require a coordinatorPubkey",
    );
  }

  // Descending type order: relays (2), coordinator pubkey (1), gid (0).
  const entries: Uint8Array[] = [];
  for (const relay of relays) {
    entries.push(encodeTlvEntry(TLV_RELAY, utf8Encoder.encode(relay)));
  }
  if (pubkeyBytes !== undefined) {
    entries.push(encodeTlvEntry(TLV_COORDINATOR_PUBKEY, pubkeyBytes));
  }
  entries.push(encodeTlvEntry(TLV_GID, gidBytes));

  const data = Buffer.concat(entries);
  return bech32.encode(PREFIX, bech32.toWords(data), MAX_LENGTH);
}

/**
 * Decode and validate a `cordn1…` group reference. Throws on any malformed or
 * spec-violating input (bad checksum, wrong prefix, missing/oversized gid,
 * duplicate gid or coordinator pubkey, relays without a coordinator pubkey,
 * or non-UTF-8 values). Unknown TLV types are ignored for forward
 * compatibility.
 */
export function decodeGroupRef(code: string): GroupRef {
  const decoded = decodeBech32(code);
  if (decoded.prefix !== PREFIX) {
    throw new Error(
      `Invalid group reference: expected prefix "${PREFIX}", got "${decoded.prefix}"`,
    );
  }

  const tlv = parseTlv(bech32.fromWords(decoded.words));

  const gidEntries = tlv.get(TLV_GID);
  if (gidEntries === undefined || gidEntries.length === 0) {
    throw new Error("Invalid group reference: missing gid");
  }
  if (gidEntries.length > 1) {
    throw new Error("Invalid group reference: multiple gids");
  }
  const gidBytes = gidEntries[0]!;
  if (gidBytes.length === 0) {
    throw new Error("Invalid group reference: gid must be non-empty");
  }
  // A gid longer than 255 bytes cannot appear in a well-framed 1-byte-length
  // TLV entry; parseTlv rejects such framing as truncated before we get here.

  const pubkeyEntries = tlv.get(TLV_COORDINATOR_PUBKEY);
  if (pubkeyEntries !== undefined && pubkeyEntries.length > 1) {
    throw new Error("Invalid group reference: multiple coordinator pubkeys");
  }
  const pubkeyBytes = pubkeyEntries?.[0];
  if (pubkeyBytes !== undefined && pubkeyBytes.length !== 32) {
    throw new Error(
      "Invalid group reference: coordinatorPubkey must be 32 bytes",
    );
  }

  const relayEntries = tlv.get(TLV_RELAY) ?? [];
  if (relayEntries.length > 0 && pubkeyBytes === undefined) {
    throw new Error(
      "Invalid group reference: relays require a coordinatorPubkey",
    );
  }

  return {
    gid: fatalUtf8Decode(gidBytes),
    ...(pubkeyBytes !== undefined
      ? { coordinatorPubkey: Buffer.from(pubkeyBytes).toString("hex") }
      : {}),
    ...(relayEntries.length > 0
      ? { relays: relayEntries.map(fatalUtf8Decode) }
      : {}),
  };
}

/** Loose, non-throwing check for whether a string looks like a cordn group
 *  reference (`cordn1…`, lowercase, with a checksum tail). Use to detect a
 *  reference among arbitrary strings or URL fragments; validate with
 *  `decodeGroupRef` before relying on it. */
export function isGroupRef(code: string): boolean {
  return /^cordn1[a-z0-9]{6,}$/.test(code);
}

function encodeTlvEntry(type: number, value: Uint8Array): Uint8Array {
  if (value.length > 255) {
    throw new Error(
      `Invalid group reference: TLV type ${type} exceeds 255 bytes`,
    );
  }
  const entry = new Uint8Array(value.length + 2);
  entry[0] = type;
  entry[1] = value.length;
  entry.set(value, 2);
  return entry;
}

function parseTlv(data: Uint8Array): Map<number, Uint8Array[]> {
  const result = new Map<number, Uint8Array[]>();
  let offset = 0;
  while (offset < data.length) {
    if (offset + 2 > data.length) {
      throw new Error("Invalid group reference: truncated TLV header");
    }
    const type = data[offset]!;
    const length = data[offset + 1]!;
    const start = offset + 2;
    const end = start + length;
    if (end > data.length) {
      throw new Error(`Invalid group reference: truncated TLV type ${type}`);
    }
    let bucket = result.get(type);
    if (bucket === undefined) {
      bucket = [];
      result.set(type, bucket);
    }
    bucket.push(data.subarray(start, end));
    offset = end;
  }
  return result;
}

function fatalUtf8Decode(bytes: Uint8Array): string {
  try {
    return fatalUtf8Decoder.decode(bytes);
  } catch {
    throw new Error("Invalid group reference: value is not valid UTF-8");
  }
}

/** Decode and checksum-verify a bech32 string, wrapping any failure (bad
 *  checksum, missing `1` separator, oversized, bech32m variant) as a uniform
 *  error. The cast satisfies @scure/base's `${string}1${string}` input type;
 *  the underlying decode throws on a missing separator regardless. */
function decodeBech32(code: string): { prefix: string; words: number[] } {
  try {
    return bech32.decode(code as `${string}1${string}`, MAX_LENGTH);
  } catch {
    throw new Error("Invalid group reference: malformed bech32");
  }
}
