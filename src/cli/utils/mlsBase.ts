import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import {
  getCiphersuiteImpl,
  nobleCryptoProvider,
  type CiphersuiteImpl,
} from "ts-mls";

const CLI_CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

export function createPrivateKeyHex(): string {
  return bytesToHex(generateSecretKey());
}

export function deriveStablePubkey(privateKey: string): string {
  return getPublicKey(Uint8Array.from(Buffer.from(privateKey, "hex")));
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

export async function getCliCiphersuite(): Promise<CiphersuiteImpl> {
  return getCiphersuiteImpl(CLI_CIPHERSUITE, nobleCryptoProvider);
}
