import type { CiphersuiteImpl } from "ts-mls";

import { GroupsManager } from "./groupsManager.ts";
import { InviteManager } from "./inviteManager.ts";
import { JoinRequestManager } from "./joinRequestManager.ts";
import {
  KeyPackageManager,
  type StoredKeyPackage,
} from "./keyPackageManager.ts";
import type { CordnSigner } from "./signer.ts";
import type { KeyValueStore } from "../storage.ts";
import type { CordnTransport } from "../transport.ts";

export interface CordnClientOptions {
  signer: CordnSigner;
  transport: CordnTransport;
  ciphersuite: CiphersuiteImpl;
  keyPackageStorage: KeyValueStore<StoredKeyPackage>;
  clock?: () => number;
}

/**
 * High-level cordn client facade. Wires a {@link CordnSigner}, a
 * {@link CordnTransport}, a ciphersuite, and key-package storage into the
 * managers apps use to create/join groups and exchange messages.
 *
 * See `design/cordn-sdk.md`.
 */
export class CordnClient {
  readonly keyPackages: KeyPackageManager;
  readonly groups: GroupsManager;
  readonly invites: InviteManager;
  readonly joinRequests: JoinRequestManager;

  constructor(opts: CordnClientOptions) {
    this.keyPackages = new KeyPackageManager({
      signer: opts.signer,
      transport: opts.transport,
      ciphersuite: opts.ciphersuite,
      storage: opts.keyPackageStorage,
      clock: opts.clock,
    });
    this.groups = new GroupsManager({
      signer: opts.signer,
      transport: opts.transport,
      ciphersuite: opts.ciphersuite,
      keyPackages: this.keyPackages,
    });
    this.invites = new InviteManager({
      signer: opts.signer,
      transport: opts.transport,
    });
    this.joinRequests = new JoinRequestManager({
      signer: opts.signer,
      transport: opts.transport,
    });
  }
}
