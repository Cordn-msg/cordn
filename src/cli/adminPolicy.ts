import {
  defaultProposalTypes,
  type ClientState,
  type IncomingMessageCallback,
} from "ts-mls";

import { normalizePubkey, type CordnGroupMetadata } from "./groupMetadata.ts";
import { UnauthorizedGroupAdminActionError } from "./sessionErrors.ts";
import { listGroupMembers } from "./utils/mlsGroupLifecycle.ts";

export function getGroupAdminPubkeys(metadata?: CordnGroupMetadata): string[] {
  return (metadata?.adminPubkeys ?? []).map(normalizePubkey);
}

export function isEgalitarianGroup(metadata?: CordnGroupMetadata): boolean {
  return getGroupAdminPubkeys(metadata).length === 0;
}

export function isGroupAdmin(params: {
  metadata?: CordnGroupMetadata;
  stablePubkey: string;
}): boolean {
  const stablePubkey = normalizePubkey(params.stablePubkey);
  const admins = getGroupAdminPubkeys(params.metadata);

  return admins.length === 0 || admins.includes(stablePubkey);
}

export function assertCanAdministerGroup(params: {
  groupAlias: string;
  metadata?: CordnGroupMetadata;
  stablePubkey: string;
}): void {
  if (
    !isGroupAdmin({
      metadata: params.metadata,
      stablePubkey: params.stablePubkey,
    })
  ) {
    throw new UnauthorizedGroupAdminActionError(params.groupAlias);
  }
}

function isAdminProposalType(proposalType: number): boolean {
  return (
    proposalType === defaultProposalTypes.add ||
    proposalType === defaultProposalTypes.remove ||
    proposalType === defaultProposalTypes.group_context_extensions
  );
}

export function commitRequiresAdmin(incoming: {
  proposals: Array<{ proposal: { proposalType: number } }>;
}): boolean {
  return incoming.proposals.some(({ proposal }) =>
    isAdminProposalType(proposal.proposalType),
  );
}

export function proposalRequiresAdmin(incoming: {
  proposal: { proposal: { proposalType: number } };
}): boolean {
  return isAdminProposalType(incoming.proposal.proposal.proposalType);
}

export function createAdminAuthorizationCallback(params: {
  state: ClientState;
  metadata?: CordnGroupMetadata;
}): IncomingMessageCallback {
  return (incoming) => {
    const requiresAdmin =
      incoming.kind === "commit"
        ? commitRequiresAdmin(incoming)
        : proposalRequiresAdmin(incoming);

    if (!requiresAdmin) {
      return "accept";
    }

    const senderLeafIndex =
      incoming.kind === "commit"
        ? incoming.senderLeafIndex
        : incoming.proposal.senderLeafIndex;

    if (senderLeafIndex === undefined) {
      return "reject";
    }

    const sender = listGroupMembers(params.state).find(
      (member) => member.leafIndex === senderLeafIndex,
    );

    if (!sender) {
      return "reject";
    }

    return isGroupAdmin({
      metadata: params.metadata,
      stablePubkey: sender.stablePubkey,
    })
      ? "accept"
      : "reject";
  };
}

export function createUnauthorizedAdminRejectionDetail(params: {
  groupAlias: string;
}): string {
  return `Rejected unauthorized admin action in group ${params.groupAlias}`;
}
