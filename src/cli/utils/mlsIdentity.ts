import { bytesToHex } from "nostr-tools/utils";
import {
  defaultCredentialTypes,
  encode,
  generateKeyPackage,
  keyPackageEncoder,
  makeKeyPackageRef,
  type Capabilities,
  type Credential,
  type KeyPackage,
  type PrivateKeyPackage,
} from "ts-mls";

import {
  CORDN_GROUP_METADATA_EXTENSION_TYPE,
  createCordnMetadataCapabilities,
} from "../groupMetadata.ts";
import {
  createPrivateKeyHex,
  deriveStablePubkey,
  encodeBase64,
  getCliCiphersuite,
} from "./mlsBase.ts";
import {
  ensureLastResortKeyPackageExtension,
  isLastResortKeyPackage,
} from "../../lastResortKeyPackage.ts";

const encoder = new TextEncoder();

export { createPrivateKeyHex, deriveStablePubkey };

export function createCredential(stablePubkey: string): Credential {
  return {
    credentialType: defaultCredentialTypes.basic,
    identity: encoder.encode(stablePubkey),
  };
}

export async function createMemberArtifacts(
  stablePubkey: string,
  options: { lastResort?: boolean } = {},
): Promise<{
  keyPackage: KeyPackage;
  privateKeyPackage: PrivateKeyPackage;
  keyPackageRef: string;
  keyPackageBase64: string;
  isLastResort: boolean;
}> {
  const cipherSuite = await getCliCiphersuite();
  const capabilities: Capabilities = createCordnMetadataCapabilities();
  const generated = await generateKeyPackage({
    credential: createCredential(stablePubkey),
    cipherSuite,
    capabilities,
    extensions: options.lastResort
      ? ensureLastResortKeyPackageExtension([])
      : undefined,
  });

  const keyPackageRef = bytesToHex(
    await makeKeyPackageRef(generated.publicPackage, cipherSuite.hash),
  );

  return {
    keyPackage: generated.publicPackage,
    privateKeyPackage: generated.privatePackage,
    keyPackageRef,
    keyPackageBase64: encodeBase64(
      encode(keyPackageEncoder, generated.publicPackage),
    ),
    isLastResort: isLastResortKeyPackage(generated.publicPackage),
  };
}

export function keyPackageSupportsCordnMetadata(
  keyPackage: KeyPackage,
): boolean {
  return keyPackage.leafNode.capabilities.extensions.includes(
    CORDN_GROUP_METADATA_EXTENSION_TYPE,
  );
}
