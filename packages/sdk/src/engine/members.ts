import {
  nodeTypes,
  type ClientState,
  type CredentialBasic,
  type NodeLeaf,
} from "ts-mls";

const decoder = new TextDecoder();

/**
 * Typed ratchet-tree member inspection. Replaces the cast-based `isMember` and
 * mirrors the battle-tested web helpers (`chatMlsUtils.findMemberLeafIndexByStablePubkey`,
 * `chatAdminPolicy.listGroupMembers`). Uses ts-mls's `nodeTypes`/`NodeLeaf`/
 * `CredentialBasic` rather than `as unknown as` casts.
 */

/** Leaf index of `stablePubkey` in the tree, or -1 if not a non-blank member. */
export function findMemberLeafIndexByStablePubkey(
  state: ClientState,
  stablePubkey: string,
): number {
  const tree = state.ratchetTree;
  if (!tree) {
    return -1;
  }
  for (let index = 0; index < tree.length; index += 1) {
    const node = tree[index];
    if (!node || node.nodeType !== nodeTypes.leaf) {
      continue;
    }
    const credential = (node as NodeLeaf).leaf.credential as CredentialBasic;
    if (!("identity" in credential) || !credential.identity) {
      continue;
    }
    if (decoder.decode(credential.identity) === stablePubkey) {
      return index / 2;
    }
  }
  return -1;
}

/** All non-blank members of the current tree. */
export function listGroupMembers(
  state: ClientState,
): Array<{ leafIndex: number; stablePubkey: string }> {
  const tree = state.ratchetTree;
  if (!tree) {
    return [];
  }
  const members: Array<{ leafIndex: number; stablePubkey: string }> = [];
  for (let index = 0; index < tree.length; index += 1) {
    const node = tree[index];
    if (!node || node.nodeType !== nodeTypes.leaf) {
      continue;
    }
    const credential = (node as NodeLeaf).leaf.credential as CredentialBasic;
    if (!("identity" in credential) || !credential.identity) {
      continue;
    }
    members.push({
      leafIndex: index / 2,
      stablePubkey: decoder.decode(credential.identity),
    });
  }
  return members;
}
