import { type ClientState } from "ts-mls";

import type {
  PendingAddMemberOperation,
  PendingRemoveMemberOperation,
} from "./pendingEpochOperations.ts";
import type {
  GroupSessionState,
  StoredKeyPackage,
  StoredWelcome,
} from "./sessionState.ts";
import {
  decodeWelcomeBase64,
  encodeWelcomeBase64,
} from "./utils/mlsEncoding.ts";
import {
  joinGroupFromWelcome,
  addMemberToGroup,
  findMemberLeafIndexByStablePubkey,
  removeMemberFromGroup,
} from "./utils/mlsGroupLifecycle.ts";
import {
  InvalidConsumedKeyPackageError,
  NoPublishedKeyPackageError,
  UnknownGroupMemberError,
} from "./sessionErrors.ts";
import { parseConsumedKeyPackage } from "./utils/publishedKeyPackage.ts";
import type { NostrEvent } from "nostr-tools";

export interface PreparedAddMemberResult {
  keyPackageReference: string;
  pendingOperation: PendingAddMemberOperation;
  commitMessageBase64: string;
}

export interface PreparedRemoveMemberResult {
  pendingOperation: PendingRemoveMemberOperation;
  commitMessageBase64: string;
  newState: ClientState;
}

export async function prepareAddMember(params: {
  groupAlias: string;
  group: GroupSessionState;
  identifier: string;
  consumeKeyPackage: (params: { identifier: string }) => Promise<{
    keyPackage: {
      keyPackageRef: string;
      stablePubkey: string;
      publicationEvent: NostrEvent;
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

  const memberKeyPackage = await parseConsumedKeyPackage(
    consumeResult.keyPackage,
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
    welcome: decodeWelcomeBase64(params.welcome.welcome_64),
    keyPackage: params.keyPackage.keyPackage,
    privateKeyPackage: params.keyPackage.privateKeyPackage,
  });

  const group = params.createGroupSessionState(params.groupAlias, joinState);
  group.lastCursor = 0;
  group.fetchCursor = 0;

  params.keyPackage.consumed = true;
  return group;
}

export async function prepareRemoveMember(params: {
  groupAlias: string;
  group: GroupSessionState;
  targetStablePubkey: string;
  deriveGroupId: (state: ClientState) => string;
}): Promise<PreparedRemoveMemberResult> {
  const removedLeafIndex = findMemberLeafIndexByStablePubkey(
    params.group.state,
    params.targetStablePubkey,
  );

  if (removedLeafIndex < 0) {
    throw new UnknownGroupMemberError(params.targetStablePubkey);
  }

  const commitResult = await removeMemberFromGroup({
    state: params.group.state,
    removedLeafIndex,
  });

  return {
    commitMessageBase64: commitResult.commitMessageBase64,
    newState: commitResult.newState,
    pendingOperation: {
      kind: "remove-member",
      groupAlias: params.groupAlias,
      groupId: params.deriveGroupId(params.group.state),
      commitMessageBase64: commitResult.commitMessageBase64,
      targetStablePubkey: params.targetStablePubkey,
      status: "pending",
    },
  };
}
