import { createHash, timingSafeEqual } from "node:crypto";
import { mlsExporter, type ClientState } from "ts-mls";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes, randomBytes } from "@noble/ciphers/utils.js";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { getCliCiphersuite } from "./mlsBase.ts";

/**
 * Encrypted media (`cordn-em-v1`), as defined in
 * `spec/applications/encrypted-media.md`.
 *
 * This is the group-payload scheme from `mlsMessages.ts` with a distinct
 * exporter context (`"encrypted-media"`) and a non-empty AAD that binds the
 * blob to its declared metadata. No new primitives.
 */

const encoder = new TextEncoder();

const EXPORTER_LABEL = "cordn";
const EXPORTER_CONTEXT = "encrypted-media";
export const MEDIA_VERSION = "cordn-em-v1" as const;

export interface MediaMetadata {
  /** MIME type. Exact UTF-8 bytes are bound into the AAD. */
  readonly mime: string;
  /** Original filename. Exact UTF-8 bytes are bound into the AAD. */
  readonly filename: string;
}

export interface EncryptedMedia {
  /** AEAD ciphertext plus the 16-byte Poly1305 authentication tag. */
  readonly blob: Uint8Array;
  /** Fresh random 12-byte nonce; carried in the `imeta` `n` field. */
  readonly nonce: Uint8Array;
  /** SHA-256 of the original file content; carried in the `imeta` `x` field. */
  readonly plaintextHash: Uint8Array;
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(data).digest());
}

/** Content-store address: SHA-256 of the encrypted blob (ciphertext + tag). */
export function blobAddress(blob: Uint8Array): Uint8Array {
  return sha256Bytes(blob);
}

/**
 * AAD = utf8(mime) || 0x00 || utf8(filename) || 0x00 || sha256(plaintext).
 * Exported so implementations can assert the exact byte layout.
 */
export function buildMediaAad(
  metadata: MediaMetadata,
  plaintextHash: Uint8Array,
): Uint8Array {
  return concatBytes(
    encoder.encode(metadata.mime),
    new Uint8Array([0x00]),
    encoder.encode(metadata.filename),
    new Uint8Array([0x00]),
    plaintextHash,
  );
}

async function deriveMediaKey(state: ClientState): Promise<Uint8Array> {
  const cipherSuite = await getCliCiphersuite();
  return mlsExporter(
    state.keySchedule.exporterSecret,
    EXPORTER_LABEL,
    encoder.encode(EXPORTER_CONTEXT),
    32,
    cipherSuite,
  );
}

export async function encryptMedia(params: {
  state: ClientState;
  plaintext: Uint8Array;
  metadata: MediaMetadata;
}): Promise<EncryptedMedia> {
  const plaintextHash = sha256Bytes(params.plaintext);
  const key = await deriveMediaKey(params.state);
  const nonce = randomBytes(12);
  const aad = buildMediaAad(params.metadata, plaintextHash);
  const blob = chacha20poly1305(key, nonce, aad).encrypt(params.plaintext);
  return { blob, nonce, plaintextHash };
}

export async function decryptMedia(params: {
  state: ClientState;
  blob: Uint8Array;
  nonce: Uint8Array;
  metadata: MediaMetadata;
  /** The `x` value from `imeta`: SHA-256 of the expected plaintext. */
  expectedPlaintextHash: Uint8Array;
}): Promise<{ plaintext: Uint8Array }> {
  if (params.nonce.length !== 12) {
    throw new Error("Invalid media nonce: expected 12 bytes");
  }
  if (params.expectedPlaintextHash.length !== 32) {
    throw new Error("Invalid media plaintext hash: expected 32 bytes");
  }
  const key = await deriveMediaKey(params.state);
  const aad = buildMediaAad(params.metadata, params.expectedPlaintextHash);
  // ponytail: noble throws on AEAD tag mismatch, which is the integrity gate
  // for tampered blobs and rewired metadata. No manual error mapping needed.
  const plaintext = chacha20poly1305(key, params.nonce, aad).decrypt(
    params.blob,
  );
  const actualHash = sha256Bytes(plaintext);
  if (!timingSafeEqual(actualHash, params.expectedPlaintextHash)) {
    throw new Error(
      "Encrypted media integrity check failed (plaintext hash mismatch)",
    );
  }
  return { plaintext };
}

// ---------------------------------------------------------------------------
// NIP-92 `imeta` tag (the transport layer for an encrypted-media reference)
// ---------------------------------------------------------------------------

export interface MediaReference {
  readonly url: string;
  readonly mime: string;
  readonly filename: string;
  /** `x`: lowercase hex SHA-256 of the original file content. */
  readonly plaintextHashHex: string;
  /** `n`: lowercase hex encoding of the 12-byte nonce (24 chars). */
  readonly nonceHex: string;
  /** `v`: encryption version, e.g. `cordn-em-v1`. */
  readonly version: string;
  readonly dim?: string;
  readonly blurhash?: string;
  readonly thumbhash?: string;
  readonly alt?: string;
}

/** Encodes a media reference as a NIP-92 `imeta` tag (`["imeta", "url ...", ...]`). */
export function buildImetaTag(ref: MediaReference): string[] {
  const tag = [
    "imeta",
    `url ${ref.url}`,
    `m ${ref.mime}`,
    `filename ${ref.filename}`,
    `x ${ref.plaintextHashHex}`,
    `n ${ref.nonceHex}`,
    `v ${ref.version}`,
  ];
  if (ref.dim) tag.push(`dim ${ref.dim}`);
  if (ref.blurhash) tag.push(`blurhash ${ref.blurhash}`);
  if (ref.thumbhash) tag.push(`thumbhash ${ref.thumbhash}`);
  if (ref.alt) tag.push(`alt ${ref.alt}`);
  return tag;
}

/**
 * Parses a single `imeta` tag. Returns `null` if it is not an `imeta` tag or is
 * missing any required field. The first space in each entry separates the key
 * from the value, so values (filename, alt) may themselves contain spaces.
 */
export function parseImetaTag(tag: string[]): MediaReference | null {
  if (tag[0] !== "imeta") return null;
  const fields: Record<string, string> = {};
  for (let i = 1; i < tag.length; i++) {
    const entry = tag[i] ?? "";
    const sep = entry.indexOf(" ");
    if (sep <= 0) continue;
    fields[entry.slice(0, sep)] = entry.slice(sep + 1);
  }
  const url = fields["url"];
  const mime = fields["m"];
  const filename = fields["filename"];
  const plaintextHashHex = fields["x"];
  const nonceHex = fields["n"];
  const version = fields["v"];
  if (
    !url ||
    !mime ||
    !filename ||
    !plaintextHashHex ||
    !nonceHex ||
    !version
  ) {
    return null;
  }
  return {
    url,
    mime,
    filename,
    plaintextHashHex,
    nonceHex,
    version,
    dim: fields["dim"],
    blurhash: fields["blurhash"],
    thumbhash: fields["thumbhash"],
    alt: fields["alt"],
  };
}

/** Returns the first parseable `imeta` media reference in a tag list, if any. */
export function findImetaTag(tags: string[][]): MediaReference | null {
  for (const tag of tags) {
    if (tag[0] !== "imeta") continue;
    const parsed = parseImetaTag(tag);
    if (parsed) return parsed;
  }
  return null;
}

export { bytesToHex, hexToBytes };
