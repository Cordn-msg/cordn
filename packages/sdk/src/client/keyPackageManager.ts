import { bytesToHex } from "nostr-tools/utils";
import { verifyEvent } from "nostr-tools";
import {
  defaultCredentialTypes,
  encode,
  generateKeyPackage,
  keyPackageEncoder,
  makeKeyPackageRef,
  type CiphersuiteImpl,
  type Credential,
  type KeyPackage,
  type PrivateKeyPackage,
} from "ts-mls";

import {
  createCordnMetadataCapabilities,
  encodeBase64,
  ensureLastResortKeyPackageExtension,
  isLastResortKeyPackage,
} from "@cordn/core";

import { keyPackageStablePubkey } from "../engine/engine.ts";
import { PublicationPayloadInvalidError } from "../engine/errors.ts";
import type { KeyValueStore } from "../storage.ts";
import type { CordnTransport, PublishedKeyPackage } from "../transport.ts";
import type { CordnSigner } from "./signer.ts";

const encoder = new TextEncoder();

/** ponytail: placeholder kind for the in-process publication event. The
 *  production path captures the signed MCP request envelope server-side; the
 *  kind is irrelevant to binding verification (signature + pubkey match). */
const KEY_PACKAGE_PUBLICATION_KIND = 1;

export interface StoredKeyPackage {
  keyPackageRef: string;
  stablePubkey: string;
  keyPackage: KeyPackage;
  privateKeyPackage: PrivateKeyPackage;
  isLastResort: boolean;
  publishedAt?: number;
}

export interface KeyPackageManagerOptions {
  signer: CordnSigner;
  transport: CordnTransport;
  ciphersuite: CiphersuiteImpl;
  storage: KeyValueStore<StoredKeyPackage>;
  clock?: () => number;
}

function basicCredential(stablePubkey: string): Credential {
  return {
    credentialType: defaultCredentialTypes.basic,
    identity: encoder.encode(stablePubkey),
  };
}

/**
 * Manages this client's key packages: generation, publication, and consuming
 * others' published packages for inviting. Encapsulates last-resort semantics
 * and the publication-payload binding verification (gotcha #6, #7).
 */
export class KeyPackageManager {
  constructor(private readonly opts: KeyPackageManagerOptions) {}

  /** Generate a new key package (and its private keys), stored locally. */
  async generate(
    options: { lastResort?: boolean } = {},
  ): Promise<StoredKeyPackage> {
    const stablePubkey = await this.opts.signer.getPublicKey();
    const lastResort = options.lastResort ?? false;
    const generated = await generateKeyPackage({
      credential: basicCredential(stablePubkey),
      cipherSuite: this.opts.ciphersuite,
      capabilities: createCordnMetadataCapabilities(),
      extensions: lastResort
        ? ensureLastResortKeyPackageExtension([])
        : undefined,
    });
    const keyPackageRef = bytesToHex(
      await makeKeyPackageRef(
        generated.publicPackage,
        this.opts.ciphersuite.hash,
      ),
    );
    const stored: StoredKeyPackage = {
      keyPackageRef,
      stablePubkey,
      keyPackage: generated.publicPackage,
      privateKeyPackage: generated.privatePackage,
      isLastResort: isLastResortKeyPackage(generated.publicPackage),
    };
    await this.opts.storage.setItem(keyPackageRef, stored);
    return stored;
  }

  /** Look up a locally-stored key package (public + private). */
  async get(keyPackageRef: string): Promise<StoredKeyPackage | null> {
    return this.opts.storage.getItem(keyPackageRef);
  }

  /** Publish a key package to the coordinator (signs the publication binding). */
  async publish(keyPackageRef: string): Promise<StoredKeyPackage> {
    const stored = await this.opts.storage.getItem(keyPackageRef);
    if (!stored) {
      throw new Error(`Unknown key package: ${keyPackageRef}`);
    }
    const publicationEvent = await this.opts.signer.signEvent({
      kind: KEY_PACKAGE_PUBLICATION_KIND,
      created_at: (this.opts.clock ?? Date.now)(),
      tags: [],
      content: encodeBase64(encode(keyPackageEncoder, stored.keyPackage)),
    });
    const record = await this.opts.transport.publishKeyPackage({
      stablePubkey: stored.stablePubkey,
      keyPackage: stored.keyPackage,
      keyPackageRef: stored.keyPackageRef,
      publicationEvent,
    });
    const updated: StoredKeyPackage = {
      ...stored,
      publishedAt: record.publishedAt,
    };
    await this.opts.storage.setItem(keyPackageRef, updated);
    return updated;
  }

  /** List a member's published key packages. */
  async list(stablePubkey: string): Promise<PublishedKeyPackage[]> {
    return this.opts.transport.listKeyPackages(stablePubkey);
  }

  /**
   * Consume (take) a published key package for inviting, verifying the
   * publication binding first (gotcha #6). Regular packages are removed on
   * consume; last-resort packages remain.
   */
  async consume(keyPackageRef: string): Promise<PublishedKeyPackage> {
    const record = await this.opts.transport.consumeKeyPackage(keyPackageRef);
    if (!record) {
      throw new Error(`Key package not found: ${keyPackageRef}`);
    }
    // Three-way publication binding (gotcha #6, matching the web's
    // parseConsumedPublishedKeyPackage): valid signature, event signer ==
    // stable pubkey, AND the key package's BasicCredential identity == same pubkey.
    if (!verifyEvent(record.publicationEvent)) {
      throw new PublicationPayloadInvalidError(
        "Invalid key package publication event signature",
      );
    }
    if (record.publicationEvent.pubkey !== record.stablePubkey) {
      throw new PublicationPayloadInvalidError(
        "Publication event signer does not match stable pubkey",
      );
    }
    if (keyPackageStablePubkey(record.keyPackage) !== record.stablePubkey) {
      throw new PublicationPayloadInvalidError(
        "Key package credential identity does not match publication signer",
      );
    }
    return record;
  }

  /** Remove a published key package from the coordinator. */
  async remove(keyPackageRef: string): Promise<void> {
    await this.opts.transport.removeKeyPackage(keyPackageRef);
  }
}
