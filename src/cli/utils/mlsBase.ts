import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import {
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  getCiphersuiteImpl,
  nobleCryptoProvider,
  type ClientConfig,
  type CiphersuiteImpl,
  type KeyPackageEqualityConfig,
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

// ts-mls rc.16 rejects an Add whose credential identity already appears in the
// ratchet tree, even when paired with a Remove of that same leaf in one commit
// (it validates against the pre-removal tree). Cordn re-invites an existing
// member by consuming a freshly published key package: same stablePubkey
// credential, but a brand-new signature key. Match key packages against
// existing leaves by signature key only, mirroring how the library already
// compares two key packages to each other. Applied on both the create- and
// process-commit paths so creators and receivers agree.
const cliKeyPackageEqualityConfig: KeyPackageEqualityConfig = {
  ...defaultKeyPackageEqualityConfig,
  compareKeyPackageToLeafNode: (keyPackage, leafNode) =>
    encodeBase64(keyPackage.leafNode.signaturePublicKey) ===
    encodeBase64(leafNode.signaturePublicKey),
};

export const cliClientConfig: ClientConfig = {
  keyRetentionConfig: defaultKeyRetentionConfig,
  lifetimeConfig: defaultLifetimeConfig,
  paddingConfig: defaultPaddingConfig,
  keyPackageEqualityConfig: cliKeyPackageEqualityConfig,
};
