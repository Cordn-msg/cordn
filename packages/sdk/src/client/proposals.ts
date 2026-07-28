import { defaultProposalTypes, type KeyPackage } from "ts-mls";

import {
  CORDN_GROUP_METADATA_EXTENSION_TYPE,
  getCordnGroupMetadataExtension,
  makeCordnGroupMetadataExtension,
  type CordnGroupMetadata,
} from "@cordn/core";

import { SelfRemovalError } from "../engine/errors.ts";
import { findMemberLeafIndexByStablePubkey } from "../engine/members.ts";
import type { ProposalAction } from "../engine/types.ts";

/**
 * Composable proposal builders (design "Proposals & actions"). Each is a
 * {@link ProposalAction} resolved against the group's state at commit time, so
 * they compose into batched commits: `group.commit([addBob, addCarol])`.
 *
 * Ported from the battle-tested web helpers (`chatMlsUtils.addMemberToGroup` /
 * `removeMemberFromGroup` / `updateGroupMetadataExtension`).
 */

/** Add a member by their (binding-verified) key package. */
export function proposeAddMember(keyPackage: KeyPackage): ProposalAction {
  return () => ({
    proposalType: defaultProposalTypes.add,
    add: { keyPackage },
  });
}

/** Remove a member by stable pubkey. Blocks self-removal (web invariant). */
export function proposeRemoveMember(stablePubkey: string): ProposalAction {
  return (ctx) => {
    if (stablePubkey === ctx.localStablePubkey) {
      throw new SelfRemovalError("Removing the local member is not supported");
    }
    const leafIndex = findMemberLeafIndexByStablePubkey(
      ctx.state,
      stablePubkey,
    );
    if (leafIndex < 0) {
      throw new Error(`No member with stable pubkey: ${stablePubkey}`);
    }
    return {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: leafIndex },
    };
  };
}

/** Update group metadata. `patch` is merged into the current metadata. */
export function proposeUpdateMetadata(
  patch: Partial<CordnGroupMetadata>,
): ProposalAction {
  return (ctx) => {
    const current = getCordnGroupMetadataExtension(ctx.state) ?? { name: "" };
    const merged: CordnGroupMetadata = { ...current, ...patch };
    const extensions = [
      ...ctx.state.groupContext.extensions.filter(
        (extension) =>
          extension.extensionType !== CORDN_GROUP_METADATA_EXTENSION_TYPE,
      ),
      makeCordnGroupMetadataExtension(merged),
    ];
    return {
      proposalType: defaultProposalTypes.group_context_extensions,
      groupContextExtensions: { extensions },
    };
  };
}
