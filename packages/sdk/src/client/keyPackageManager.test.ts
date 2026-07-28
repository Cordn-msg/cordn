import { describe, expect, test } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  createActor,
  createMemberArtifacts,
  getTestCiphersuite,
} from "@cordn/test-utils";

import { InMemoryKeyValueStore } from "../extra/inMemoryStore.ts";
import type { CordnTransport, PublishedKeyPackage } from "../transport.ts";
import { KeyPackageManager } from "./keyPackageManager.ts";
import type { CordnSigner } from "./signer.ts";

const noopSigner: CordnSigner = {
  getPublicKey: async () => "00".repeat(32),
  signEvent: async () => {
    throw new Error("unused");
  },
};

function transportReturning(
  record: PublishedKeyPackage | null,
): CordnTransport {
  return { consumeKeyPackage: async () => record } as unknown as CordnTransport;
}

function signedEmptyEvent(secret: Uint8Array) {
  return finalizeEvent(
    { kind: 1, created_at: 0, tags: [], content: "" },
    secret,
  );
}

describe("KeyPackageManager.consume — three-way publication binding", () => {
  test("rejects when the event signer differs from the stable pubkey", async () => {
    const ciphersuite = await getTestCiphersuite();
    const aliceSecret = generateSecretKey();
    const bob = await createMemberArtifacts(createActor("bob"));

    const record: PublishedKeyPackage = {
      stablePubkey: bob.actor.stablePubkey, // claims bob
      keyPackage: bob.keyPackage, // identity == bob
      keyPackageRef: "ref",
      isLastResort: false,
      publishedAt: 0,
      publicationEvent: signedEmptyEvent(aliceSecret), // signed by alice
    };
    const manager = new KeyPackageManager({
      signer: noopSigner,
      transport: transportReturning(record),
      ciphersuite,
      storage: new InMemoryKeyValueStore(),
    });

    await expect(manager.consume("ref")).rejects.toThrow(
      /does not match stable pubkey/,
    );
  });

  test("rejects when the key package identity differs from the signer", async () => {
    const ciphersuite = await getTestCiphersuite();
    const signerSecret = generateSecretKey();
    const signerPubkey = getPublicKey(signerSecret);
    // key package belongs to a DIFFERENT identity (carol).
    const carol = await createMemberArtifacts(createActor("carol"));

    const record: PublishedKeyPackage = {
      stablePubkey: signerPubkey,
      keyPackage: carol.keyPackage, // identity == carol
      keyPackageRef: "ref",
      isLastResort: false,
      publishedAt: 0,
      publicationEvent: signedEmptyEvent(signerSecret), // signer == stablePubkey
    };
    const manager = new KeyPackageManager({
      signer: noopSigner,
      transport: transportReturning(record),
      ciphersuite,
      storage: new InMemoryKeyValueStore(),
    });

    await expect(manager.consume("ref")).rejects.toThrow(
      /does not match publication signer/,
    );
  });
});
