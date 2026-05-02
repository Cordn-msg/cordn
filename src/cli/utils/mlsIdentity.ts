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

const encoder = new TextEncoder();

export { createPrivateKeyHex, deriveStablePubkey };

export function createCredential(stablePubkey: string): Credential {
  return {
    credentialType: defaultCredentialTypes.basic,
    identity: encoder.encode(stablePubkey),
  };
}

export async function createMemberArtifacts(stablePubkey: string): Promise<{
  keyPackage: KeyPackage;
  privateKeyPackage: PrivateKeyPackage;
  keyPackageRef: string;
  keyPackageBase64: string;
}> {
  const cipherSuite = await getCliCiphersuite();
  const capabilities: Capabilities = createCordnMetadataCapabilities();
  const generated = await generateKeyPackage({
    credential: createCredential(stablePubkey),
    cipherSuite,
    capabilities,
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
  };
}

export function keyPackageSupportsCordnMetadata(
  keyPackage: KeyPackage,
): boolean {
  return keyPackage.leafNode.capabilities.extensions.includes(
    CORDN_GROUP_METADATA_EXTENSION_TYPE,
  );
}
