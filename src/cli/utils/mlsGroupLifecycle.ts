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
	type Welcome
} from 'ts-mls';

import { makeCordnGroupMetadataExtension, type CordnGroupMetadata } from '../groupMetadata.ts';
import { encodeBase64, getCliCiphersuite } from './mlsBase.ts';
import { MissingCommitWelcomeError } from '../sessionErrors.ts';

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
		extensions
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
				proposalType: defaultProposalTypes.add,
				add: {
					keyPackage: params.memberKeyPackage
				}
			}
		]
	});

	if (!result.welcome) {
		throw new MissingCommitWelcomeError();
	}

	return {
		newState: result.newState,
		welcome: result.welcome.welcome,
		commitMessageBase64: encodeBase64(encode(mlsMessageEncoder, result.commit))
	};
}

export async function replaceMemberInGroup(params: {
	state: ClientState;
	memberKeyPackage: KeyPackage;
	removedLeafIndex: number;
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
				proposalType: defaultProposalTypes.remove,
				remove: {
					removed: params.removedLeafIndex
				}
			},
			{
				proposalType: defaultProposalTypes.add,
				add: {
					keyPackage: params.memberKeyPackage
				}
			}
		]
	});

	if (!result.welcome) {
		throw new MissingCommitWelcomeError();
	}

	return {
		newState: result.newState,
		welcome: result.welcome.welcome,
		commitMessageBase64: encodeBase64(encode(mlsMessageEncoder, result.commit))
	};
}

function decodeCredentialIdentity(identity: Uint8Array): string {
	return new TextDecoder().decode(identity);
}

/**
 * List all non-blank members of the current ratchet tree.
 *
 * Note: this directly inspects ts-mls ratchet-tree internals and
 * assumes Cordn's credential identity equals the stable pubkey.
 * Keep this as the single source of truth for member lookup.
 */
export function listGroupMembers(
	state: ClientState
): Array<{ leafIndex: number; stablePubkey: string }> {
	const leaves = state.ratchetTree as
		| Array<
				| {
						nodeType?: number;
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
		return [];
	}

	const members: Array<{ leafIndex: number; stablePubkey: string }> = [];
	for (let index = 0; index < leaves.length; index += 1) {
		const node = leaves[index];
		if (node?.nodeType !== 1) {
			continue;
		}

		const leaf = node?.leaf;
		if (!leaf) {
			continue;
		}

		const credential = leaf.credential;
		if (credential && 'identity' in credential && credential.identity) {
			members.push({
				leafIndex: index / 2,
				stablePubkey: decodeCredentialIdentity(credential.identity)
			});
		}
	}

	return members;
}

export function findMemberLeafIndexByStablePubkey(
	state: ClientState,
	stablePubkey: string
): number {
	const member = listGroupMembers(state).find((m) => m.stablePubkey === stablePubkey);
	return member?.leafIndex ?? -1;
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
					removed: params.removedLeafIndex
				}
			}
		]
	});

	return {
		newState: result.newState,
		commitMessageBase64: encodeBase64(encode(mlsMessageEncoder, result.commit))
	};
}

export async function updateGroupMetadataExtension(params: {
	state: ClientState;
	metadata: CordnGroupMetadata;
}): Promise<{
	newState: ClientState;
	commitMessageBase64: string;
}> {
	const cipherSuite = await getCliCiphersuite();
	const extensions = [
		...params.state.groupContext.extensions.filter(
			(extension) => extension.extensionType !== 0xc04d
		),
		makeCordnGroupMetadataExtension(params.metadata)
	];
	const result = await createCommit({
		context: { cipherSuite, authService: unsafeTestingAuthenticationService },
		state: params.state,
		ratchetTreeExtension: true,
		extraProposals: [
			{
				proposalType: defaultProposalTypes.group_context_extensions,
				groupContextExtensions: {
					extensions
				}
			}
		]
	});

	return {
		newState: result.newState,
		commitMessageBase64: encodeBase64(encode(mlsMessageEncoder, result.commit))
	};
}

export async function joinGroupFromWelcome(params: {
	welcome: Welcome;
	keyPackage: KeyPackage;
	privateKeyPackage: PrivateKeyPackage;
	ratchetTree?: ClientState['ratchetTree'];
}): Promise<ClientState> {
	const cipherSuite = await getCliCiphersuite();
	return joinGroup({
		context: { cipherSuite, authService: unsafeTestingAuthenticationService },
		welcome: params.welcome,
		keyPackage: params.keyPackage,
		privateKeys: params.privateKeyPackage,
		ratchetTree: params.ratchetTree
	});
}
