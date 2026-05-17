import {
  createCommit,
  createGroup,
  defaultProposalTypes,
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

function decodeCredentialIdentity(identity: Uint8Array): string {
  return new TextDecoder().decode(identity);
}

export function findMemberLeafIndexByStablePubkey(
  state: ClientState,
  stablePubkey: string,
): number {
  const leaves = state.ratchetTree as
    | Array<
        | {
            leaf?: {
              credential?: {
                identity?: Uint8Array;
              };
            };
          }
        | undefined
      >
    | undefined;

  if (!leaves) {
    return -1;
  }

  for (let index = 0; index < leaves.length; index += 1) {
    const node = leaves[index];
    const leaf = node?.leaf;
    if (!leaf) {
      continue;
    }

    const credential = leaf.credential;
    if (
      credential &&
      "identity" in credential &&
      credential.identity &&
      decodeCredentialIdentity(credential.identity) === stablePubkey
    ) {
      return Math.floor(index / 2);
    }
  }

  return -1;
}

export async function removeMemberFromGroup(params: {
  state: ClientState;
  removedLeafIndex: number;
}): Promise<{
  newState: ClientState;
  commitMessageBase64: string;
}> {
  const cipherSuite = await getCliCiphersuite();
  const result = await createCommit({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: params.state,
    ratchetTreeExtension: true,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.remove,
        remove: {
          removed: params.removedLeafIndex,
        },
      },
    ],
  });

  return {
    newState: result.newState,
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
