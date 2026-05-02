import { decode, keyPackageDecoder, type ClientState } from "ts-mls";

import type { PendingAddMemberOperation } from "./pendingEpochOperations.ts";
import type {
  GroupSessionState,
  StoredKeyPackage,
  StoredWelcome,
} from "./sessionState.ts";
import { decodeBase64 } from "./utils/mlsBase.ts";
import {
  decodeWelcomeBase64,
  encodeWelcomeBase64,
} from "./utils/mlsEncoding.ts";
import {
  joinGroupFromWelcome,
  addMemberToGroup,
} from "./utils/mlsGroupLifecycle.ts";
import {
  InvalidConsumedKeyPackageError,
  NoPublishedKeyPackageError,
} from "./sessionErrors.ts";

export interface PreparedAddMemberResult {
  keyPackageReference: string;
  pendingOperation: PendingAddMemberOperation;
  commitMessageBase64: string;
}

export async function prepareAddMember(params: {
  groupAlias: string;
  group: GroupSessionState;
  identifier: string;
  consumeKeyPackage: (params: { identifier: string }) => Promise<{
    keyPackage: {
      keyPackageBase64: string;
      keyPackageRef: string;
      stablePubkey: string;
    } | null;
  }>;
  deriveGroupId: (state: ClientState) => string;
}): Promise<PreparedAddMemberResult> {
  const consumeResult = await params.consumeKeyPackage({
    identifier: params.identifier,
  });

  if (!consumeResult.keyPackage) {
    throw new NoPublishedKeyPackageError(params.identifier);
  }

  const memberKeyPackage = decode(
    keyPackageDecoder,
    decodeBase64(consumeResult.keyPackage.keyPackageBase64),
  );

  if (!memberKeyPackage) {
    throw new InvalidConsumedKeyPackageError();
  }

  const commitResult = await addMemberToGroup({
    state: params.group.state,
    memberKeyPackage,
  });

  return {
    keyPackageReference: consumeResult.keyPackage.keyPackageRef,
    commitMessageBase64: commitResult.commitMessageBase64,
    pendingOperation: {
      kind: "add-member",
      groupAlias: params.groupAlias,
      groupId: params.deriveGroupId(params.group.state),
      commitMessageBase64: commitResult.commitMessageBase64,
      keyPackageReference: consumeResult.keyPackage.keyPackageRef,
      targetStablePubkey: consumeResult.keyPackage.stablePubkey,
      welcomeBase64: encodeWelcomeBase64(commitResult.welcome),
      status: "pending",
    },
  };
}

export async function acceptStoredWelcome(params: {
  keyPackageReference: string;
  groupAlias: string;
  welcome: StoredWelcome;
  keyPackage: StoredKeyPackage;
  createGroupSessionState: (
    alias: string,
    state: ClientState,
  ) => GroupSessionState;
}): Promise<GroupSessionState> {
  const joinState = await joinGroupFromWelcome({
    welcome: decodeWelcomeBase64(params.welcome.welcomeBase64),
    keyPackage: params.keyPackage.keyPackage,
    privateKeyPackage: params.keyPackage.privateKeyPackage,
  });

  const group = params.createGroupSessionState(params.groupAlias, joinState);
  group.lastCursor = 0;
  group.fetchCursor = 0;

  params.keyPackage.consumed = true;
  return group;
}
