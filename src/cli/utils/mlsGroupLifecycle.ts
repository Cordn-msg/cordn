import {
  createCommit,
  createGroup,
  encode,
  joinGroup,
  mlsMessageEncoder,
  unsafeTestingAuthenticationService,
  type ClientState,
  type GroupContextExtension,
  type KeyPackage,
  type PrivateKeyPackage,
  type Welcome,
} from "ts-mls";

import {
  makeCordnGroupMetadataExtension,
  type CordnGroupMetadata,
} from "../groupMetadata.ts";
import { encodeBase64, getCliCiphersuite } from "./mlsBase.ts";
import { MissingCommitWelcomeError } from "../sessionErrors.ts";

const encoder = new TextEncoder();

export async function createGroupState(params: {
  groupId: string;
  keyPackage: KeyPackage;
  privateKeyPackage: PrivateKeyPackage;
  metadata?: CordnGroupMetadata;
}): Promise<ClientState> {
  const cipherSuite = await getCliCiphersuite();
  const extensions: GroupContextExtension[] = params.metadata
    ? [makeCordnGroupMetadataExtension(params.metadata)]
    : [];

  return createGroup({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    groupId: encoder.encode(params.groupId),
    keyPackage: params.keyPackage,
    privateKeyPackage: params.privateKeyPackage,
    extensions,
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
    throw new MissingCommitWelcomeError();
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
