import {
  createGroup,
  joinGroup,
  joinGroupWithExtensions,
  unsafeTestingAuthenticationService,
  type CiphersuiteImpl,
  type ClientState,
  type Welcome,
} from "ts-mls";

import {
  getCordnGroupMetadataExtension,
  makeCordnGroupMetadataExtension,
  type CordnGroupMetadata,
} from "@cordn/core";

import { CordnGroupEngine } from "../engine/engine.ts";
import { listGroupMembers } from "../engine/members.ts";
import { CordnGroup } from "../group.ts";
import type { SerializedGroupBlob } from "../storage.ts";
import type { CordnTransport } from "../transport.ts";
import type {
  KeyPackageManager,
  StoredKeyPackage,
} from "./keyPackageManager.ts";
import type { CordnSigner } from "./signer.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Group metadata + members as seen by previewing a welcome before joining. */
export interface CordnGroupMetadataPreview {
  name?: string;
  description?: string;
  icon?: string;
  imageUrl?: string;
  adminPubkeys?: string[];
  memberPubkeys: string[];
}

export interface GroupsManagerOptions {
  signer: CordnSigner;
  transport: CordnTransport;
  ciphersuite: CiphersuiteImpl;
  keyPackages: KeyPackageManager;
}

/**
 * Creates groups and joins them from welcomes, returning {@link CordnGroup}
 * sessions. Encapsulates the metadata extension advertisement and the
 * joinAfterCursor handoff so a freshly-joined member skips pre-join traffic.
 */
export class GroupsManager {
  constructor(private readonly opts: GroupsManagerOptions) {}

  /** Create a new group with this client as the founder. */
  async create(params: {
    groupId: string;
    metadata?: CordnGroupMetadata;
    keyPackageRef?: string;
  }): Promise<CordnGroup> {
    const stablePubkey = await this.opts.signer.getPublicKey();
    const stored = params.keyPackageRef
      ? await this.requireStored(params.keyPackageRef)
      : await this.opts.keyPackages.generate();
    const extensions = params.metadata
      ? [makeCordnGroupMetadataExtension(params.metadata)]
      : [];
    const state = await createGroup({
      context: {
        cipherSuite: this.opts.ciphersuite,
        authService: unsafeTestingAuthenticationService,
      },
      groupId: encoder.encode(params.groupId),
      keyPackage: stored.keyPackage,
      privateKeyPackage: stored.privateKeyPackage,
      extensions,
    });
    return this.wrap(params.groupId, state, stablePubkey);
  }

  /** Join an existing group from a welcome (fetched via {@link InviteManager}). */
  async joinFromWelcome(params: {
    welcome: Welcome;
    keyPackageRef: string;
    joinAfterCursor?: number;
  }): Promise<CordnGroup> {
    const stablePubkey = await this.opts.signer.getPublicKey();
    const stored = await this.requireStored(params.keyPackageRef);
    const state = await joinGroup({
      context: {
        cipherSuite: this.opts.ciphersuite,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: params.welcome,
      keyPackage: stored.keyPackage,
      privateKeys: stored.privateKeyPackage,
    });
    const groupId = decoder.decode(state.groupContext.groupId);
    return this.wrap(groupId, state, stablePubkey, params.joinAfterCursor);
  }

  /** Restore a group from a prior `CordnGroup.serialize()` snapshot (recovery). */
  async load(blob: SerializedGroupBlob): Promise<CordnGroup> {
    const stablePubkey = await this.opts.signer.getPublicKey();
    const engine = CordnGroupEngine.fromSerialized(blob.engine, {
      ciphersuite: this.opts.ciphersuite,
      localStablePubkey: stablePubkey,
    });
    return new CordnGroup({
      groupId: blob.groupId,
      engine,
      transport: this.opts.transport,
      fetchCursor: blob.fetchCursor,
      lastCursor: blob.lastCursor,
    });
  }

  /** Preview a welcome's group metadata + members without joining (gotcha #9). */
  async previewWelcome(params: {
    welcome: Welcome;
    keyPackageRef: string;
  }): Promise<CordnGroupMetadataPreview> {
    const stored = await this.requireStored(params.keyPackageRef);
    const result = await joinGroupWithExtensions({
      context: {
        cipherSuite: this.opts.ciphersuite,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: params.welcome,
      keyPackage: stored.keyPackage,
      privateKeys: stored.privateKeyPackage,
    });
    const metadata = getCordnGroupMetadataExtension(result.state);
    return {
      name: metadata?.name,
      description: metadata?.description,
      icon: metadata?.icon,
      imageUrl: metadata?.imageUrl,
      adminPubkeys: metadata?.adminPubkeys,
      memberPubkeys: listGroupMembers(result.state).map((m) => m.stablePubkey),
    };
  }

  private async requireStored(
    keyPackageRef: string,
  ): Promise<StoredKeyPackage> {
    const stored = await this.opts.keyPackages.get(keyPackageRef);
    if (!stored) {
      throw new Error(`Unknown key package: ${keyPackageRef}`);
    }
    return stored;
  }

  private wrap(
    groupId: string,
    state: ClientState,
    stablePubkey: string,
    fetchCursor?: number,
  ): CordnGroup {
    const engine = new CordnGroupEngine(state, {
      ciphersuite: this.opts.ciphersuite,
      localStablePubkey: stablePubkey,
    });
    return new CordnGroup({
      groupId,
      engine,
      transport: this.opts.transport,
      fetchCursor,
      lastCursor: fetchCursor,
    });
  }
}
