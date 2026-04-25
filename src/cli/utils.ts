import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import {
  createApplicationMessage,
  createCommit,
  createGroup,
  defaultCredentialTypes,
  encode,
  generateKeyPackage,
  getCiphersuiteImpl,
  joinGroup,
  keyPackageEncoder,
  makeKeyPackageRef,
  mlsMessageDecoder,
  mlsMessageEncoder,
  nobleCryptoProvider,
  processMessage,
  unsafeTestingAuthenticationService,
  type CiphersuiteImpl,
  type ClientState,
  type Credential,
  type KeyPackage,
  type PrivateKeyPackage,
  type Welcome,
} from "ts-mls";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CLI_CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

export function createPrivateKeyHex(): string {
  return bytesToHex(generateSecretKey());
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

export function createCredential(stablePubkey: string): Credential {
  return {
    credentialType: defaultCredentialTypes.basic,
    identity: encoder.encode(stablePubkey),
  };
}

export function deriveStablePubkey(privateKey: string): string {
  return getPublicKey(Uint8Array.from(Buffer.from(privateKey, "hex")));
}

export async function createMemberArtifacts(stablePubkey: string): Promise<{
  keyPackage: KeyPackage;
  privateKeyPackage: PrivateKeyPackage;
  keyPackageRef: string;
  keyPackageBase64: string;
}> {
  const cipherSuite = await getCliCiphersuite();
  const generated = await generateKeyPackage({
    credential: createCredential(stablePubkey),
    cipherSuite,
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

export async function createGroupState(params: {
  groupId: string;
  keyPackage: KeyPackage;
  privateKeyPackage: PrivateKeyPackage;
}): Promise<ClientState> {
  const cipherSuite = await getCliCiphersuite();

  return createGroup({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    groupId: encoder.encode(params.groupId),
    keyPackage: params.keyPackage,
    privateKeyPackage: params.privateKeyPackage,
  });
}

export async function addMemberToGroup(params: {
  state: ClientState;
  memberKeyPackage: KeyPackage;
}): Promise<{
  newState: ClientState;
  welcome: Welcome;
  commitMessageBase64: string;
}> {
  const cipherSuite = await getCliCiphersuite();
  const result = await createCommit({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: params.state,
    ratchetTreeExtension: true,
    extraProposals: [
      {
        proposalType: 1,
        add: {
          keyPackage: params.memberKeyPackage,
        },
      },
    ],
  });

  if (!result.welcome) {
    throw new Error("Expected add-member commit to produce a welcome");
  }

  return {
    newState: result.newState,
    welcome: result.welcome.welcome,
    commitMessageBase64: encodeBase64(encode(mlsMessageEncoder, result.commit)),
  };
}

export async function joinGroupFromWelcome(params: {
  welcome: Welcome;
  keyPackage: KeyPackage;
  privateKeyPackage: PrivateKeyPackage;
  ratchetTree?: ClientState["ratchetTree"];
}): Promise<ClientState> {
  const cipherSuite = await getCliCiphersuite();
  return joinGroup({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    welcome: params.welcome,
    keyPackage: params.keyPackage,
    privateKeys: params.privateKeyPackage,
    ratchetTree: params.ratchetTree,
  });
}

export async function createApplicationMessageBase64(params: {
  state: ClientState;
  plaintext: string;
  authenticatedData?: Uint8Array;
}): Promise<{ newState: ClientState; opaqueMessageBase64: string }> {
  const cipherSuite = await getCliCiphersuite();
  const result = await createApplicationMessage({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: params.state,
    message: encoder.encode(params.plaintext),
    authenticatedData: params.authenticatedData,
  });

  return {
    newState: result.newState,
    opaqueMessageBase64: encodeBase64(
      encode(mlsMessageEncoder, result.message),
    ),
  };
}

export async function processMessageBase64(params: {
  state: ClientState;
  opaqueMessageBase64: string;
}): Promise<Awaited<ReturnType<typeof processMessage>>> {
  const cipherSuite = await getCliCiphersuite();
  const decoded = mlsMessageDecoder(
    decodeBase64(params.opaqueMessageBase64),
    0,
  );

  if (!decoded) {
    throw new Error("Unable to decode MLS message");
  }

  if (decoded[0].wireformat !== 2 && decoded[0].wireformat !== 1) {
    throw new Error("Expected framed MLS message");
  }

  return processMessage({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: params.state,
    message: decoded[0],
  });
}

export function decodeWelcomeBase64(welcomeBase64: string): Welcome {
  const decoded = mlsMessageDecoder(decodeBase64(welcomeBase64), 0);

  if (!decoded || decoded[0].wireformat !== 3) {
    throw new Error("Expected MLS welcome message");
  }

  return decoded[0].welcome;
}

export function encodeWelcomeBase64(welcome: Welcome): string {
  return encodeBase64(
    encode(mlsMessageEncoder, { version: 1, wireformat: 3, welcome }),
  );
}

export function decodeApplicationData(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function encodeAuthenticatedSender(stablePubkey: string): Uint8Array {
  return encoder.encode(stablePubkey);
}

export function decodeAuthenticatedSender(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
