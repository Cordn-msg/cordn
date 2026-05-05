import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import {
  createCommit,
  createApplicationMessage,
  createProposal,
  createGroup,
  defaultCredentialTypes,
  generateKeyPackage,
  getCiphersuiteImpl,
  makeKeyPackageRef,
  nobleCryptoProvider,
  processMessage,
  processPrivateMessage,
  unsafeTestingAuthenticationService,
  defaultProposalTypes,
  joinGroup,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  wireformats,
  type Credential,
  type CiphersuiteImpl,
  type ClientState,
  type KeyPackage,
  type MlsFramedMessage,
  type PrivateKeyPackage,
  type ProposalAdd,
  type Proposal,
  type Welcome,
} from "ts-mls";
import { ensureLastResortKeyPackageExtension } from "../lastResortKeyPackage.ts";

export interface TestActor {
  name: string;
  secretKey: Uint8Array;
  stablePubkey: string;
}

export interface TestMemberArtifacts {
  actor: TestActor;
  keyPackage: KeyPackage;
  privateKeyPackage: PrivateKeyPackage;
}

export interface JoinedMemberArtifacts extends TestMemberArtifacts {
  state: ClientState;
}

export interface CoordinatorPostedMessage {
  cursor: number;
  groupId: string;
  opaqueMessage: Uint8Array;
}

const encoder = new TextEncoder();
const TEST_CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

export async function getTestCiphersuite(): Promise<CiphersuiteImpl> {
  return getCiphersuiteImpl(TEST_CIPHERSUITE, nobleCryptoProvider);
}

export function createActor(name: string): TestActor {
  const secretKey = generateSecretKey();

  return {
    name,
    secretKey,
    stablePubkey: getPublicKey(secretKey),
  };
}

export function createEphemeralPubkey(): string {
  return getPublicKey(generateSecretKey());
}

export function createBytes(values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

export function createPrivateMessage(params: {
  groupId?: string;
  epoch: bigint;
  contentType: 1 | 2 | 3;
  bytes: number[];
}): Uint8Array {
  return encode(mlsMessageEncoder, {
    version: 1,
    wireformat: wireformats.mls_private_message,
    privateMessage: {
      groupId: encoder.encode(params.groupId ?? "group-local"),
      epoch: params.epoch,
      contentType: params.contentType,
      authenticatedData: new Uint8Array(),
      encryptedSenderData: new Uint8Array(),
      ciphertext: Uint8Array.from(params.bytes),
    },
  });
}

export function createCredential(stablePubkey: string): Credential {
  return {
    credentialType: defaultCredentialTypes.basic,
    identity: encoder.encode(stablePubkey),
  };
}

export async function createMemberArtifacts(
  actor: TestActor,
  options: { lastResort?: boolean } = {},
): Promise<TestMemberArtifacts> {
  const cipherSuite = await getTestCiphersuite();
  const generated = await generateKeyPackage({
    credential: createCredential(actor.stablePubkey),
    cipherSuite,
    extensions: options.lastResort
      ? ensureLastResortKeyPackageExtension([])
      : undefined,
  });

  return {
    actor,
    keyPackage: generated.publicPackage,
    privateKeyPackage: generated.privatePackage,
  };
}

export async function createKeyPackageRef(
  keyPackage: KeyPackage,
): Promise<string> {
  const cipherSuite = await getTestCiphersuite();
  return bytesToHex(await makeKeyPackageRef(keyPackage, cipherSuite.hash));
}

export async function createWelcomeForNewMember(params: {
  senderState: ClientState;
  member: TestMemberArtifacts;
}): Promise<{
  senderState: ClientState;
  receiverState: ClientState;
  welcome: Welcome;
  keyPackageRefHex: string;
  commitMessageBytes: Uint8Array;
}> {
  const cipherSuite = await getTestCiphersuite();
  const addProposal: ProposalAdd = {
    proposalType: defaultProposalTypes.add,
    add: {
      keyPackage: params.member.keyPackage,
    },
  };

  const commitResult = await createCommit({
    context: {
      cipherSuite,
      authService: unsafeTestingAuthenticationService,
    },
    state: params.senderState,
    extraProposals: [addProposal],
  });

  if (!commitResult.welcome) {
    throw new Error("Expected add-member commit to produce a welcome");
  }

  const receiverState = await joinGroupFromWelcome({
    welcome: commitResult.welcome.welcome,
    member: params.member,
    ratchetTree: commitResult.newState.ratchetTree,
  });

  return {
    senderState: commitResult.newState,
    receiverState,
    welcome: commitResult.welcome.welcome,
    keyPackageRefHex: await createKeyPackageRef(params.member.keyPackage),
    commitMessageBytes: encode(mlsMessageEncoder, commitResult.commit),
  };
}

export async function createThreeActorGroupScenario(): Promise<{
  alice: JoinedMemberArtifacts;
  bob: JoinedMemberArtifacts;
  carol: JoinedMemberArtifacts;
  bobWelcome: Welcome;
  carolWelcome: Welcome;
  bobKeyPackageRef: string;
  carolKeyPackageRef: string;
  commitMessageBytes: Uint8Array;
  aliceApplicationBytes: Uint8Array;
  bobApplicationBytes: Uint8Array;
}> {
  const aliceBase = await createMemberArtifacts(createActor("alice"));
  const bob = await createMemberArtifacts(createActor("bob"));
  const carol = await createMemberArtifacts(createActor("carol"));
  const cipherSuite = await getTestCiphersuite();
  const groupId = encoder.encode("group-alice-bob-carol");

  let aliceState = await createGroup({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    groupId,
    keyPackage: aliceBase.keyPackage,
    privateKeyPackage: aliceBase.privateKeyPackage,
  });

  const bobJoin = await createWelcomeForNewMember({
    senderState: aliceState,
    member: bob,
  });
  aliceState = bobJoin.senderState;

  const carolJoin = await createWelcomeForNewMember({
    senderState: aliceState,
    member: carol,
  });
  aliceState = carolJoin.senderState;

  const bobAfterCommit = await processPrivateMessage({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: bobJoin.receiverState,
    privateMessage: decodeCommitPrivateMessage(carolJoin.commitMessageBytes),
  });

  if (bobAfterCommit.kind !== "newState") {
    throw new Error("Expected Carol add commit to advance Bob state");
  }

  const aliceApplication = await createApplicationMessage({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: aliceState,
    message: encoder.encode("hello from alice"),
  });

  const bobApplication = await createApplicationMessage({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: bobAfterCommit.newState,
    message: encoder.encode("hello from bob"),
  });

  return {
    alice: { ...aliceBase, state: aliceApplication.newState },
    bob: { ...bob, state: bobApplication.newState },
    carol: { ...carol, state: carolJoin.receiverState },
    bobWelcome: bobJoin.welcome,
    carolWelcome: carolJoin.welcome,
    bobKeyPackageRef: bobJoin.keyPackageRefHex,
    carolKeyPackageRef: carolJoin.keyPackageRefHex,
    commitMessageBytes: carolJoin.commitMessageBytes,
    aliceApplicationBytes: encode(mlsMessageEncoder, aliceApplication.message),
    bobApplicationBytes: encode(mlsMessageEncoder, bobApplication.message),
  };
}

export function decodeMlsFramedMessage(
  encodedMessage: Uint8Array,
): MlsFramedMessage {
  const decoded = mlsMessageDecoder(encodedMessage, 0);

  if (!decoded) {
    throw new Error("Unable to decode MLS message");
  }

  if (
    decoded[0].wireformat !== wireformats.mls_private_message &&
    decoded[0].wireformat !== wireformats.mls_public_message
  ) {
    throw new Error("Expected encoded message to decode as MLS framed message");
  }

  return decoded[0];
}

export async function createApplicationMessageBytes(params: {
  state: ClientState;
  plaintext: string;
}): Promise<{ newState: ClientState; encodedMessage: Uint8Array }> {
  const cipherSuite = await getTestCiphersuite();
  const result = await createApplicationMessage({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: params.state,
    message: encoder.encode(params.plaintext),
  });

  return {
    newState: result.newState,
    encodedMessage: encode(mlsMessageEncoder, result.message),
  };
}

export async function createProposalMessageBytes(params: {
  state: ClientState;
  proposal: Proposal;
  wireAsPublicMessage?: boolean;
}): Promise<{ newState: ClientState; encodedMessage: Uint8Array }> {
  const cipherSuite = await getTestCiphersuite();
  const result = await createProposal({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: params.state,
    proposal: params.proposal,
    wireAsPublicMessage: params.wireAsPublicMessage,
  });

  return {
    newState: result.newState,
    encodedMessage: encode(mlsMessageEncoder, result.message),
  };
}

export async function createCommitMessageBytes(params: {
  state: ClientState;
  extraProposals?: Proposal[];
}): Promise<{
  newState: ClientState;
  encodedMessage: Uint8Array;
  welcome?: Welcome;
}> {
  const cipherSuite = await getTestCiphersuite();
  const result = await createCommit({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: params.state,
    extraProposals: params.extraProposals,
  });

  return {
    newState: result.newState,
    encodedMessage: encode(mlsMessageEncoder, result.commit),
    welcome: result.welcome?.welcome,
  };
}

export async function processMessageBytes(params: {
  state: ClientState;
  encodedMessage: Uint8Array;
}): Promise<Awaited<ReturnType<typeof processMessage>>> {
  const cipherSuite = await getTestCiphersuite();
  return processMessage({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: params.state,
    message: decodeMlsFramedMessage(params.encodedMessage),
  });
}

async function joinGroupFromWelcome(params: {
  welcome: Welcome;
  member: TestMemberArtifacts;
  ratchetTree: ClientState["ratchetTree"];
}): Promise<ClientState> {
  const cipherSuite = await getTestCiphersuite();
  return joinGroup({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    welcome: params.welcome,
    keyPackage: params.member.keyPackage,
    privateKeys: params.member.privateKeyPackage,
    ratchetTree: params.ratchetTree,
  });
}

function decodeCommitPrivateMessage(encodedMessage: Uint8Array) {
  const decoded = decodeMlsFramedMessage(encodedMessage);

  if (decoded.wireformat !== wireformats.mls_private_message) {
    throw new Error("Expected encoded commit to decode as MLS private message");
  }

  return decoded.privateMessage;
}
