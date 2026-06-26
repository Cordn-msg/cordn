import { describe, expect, test } from "vitest";
import { createGroup, unsafeTestingAuthenticationService } from "ts-mls";

import {
  createActor,
  createMemberArtifacts,
  getTestCiphersuite,
} from "../../coordinator/testUtils.ts";
import { encodeBase64 } from "./mlsBase.ts";
import { decryptGroupPayload, encryptGroupPayload } from "./mlsMessages.ts";

async function createSoloGroupState(groupId: string) {
  const cipherSuite = await getTestCiphersuite();
  const member = await createMemberArtifacts(createActor(groupId));
  return createGroup({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    groupId: new TextEncoder().encode(groupId),
    keyPackage: member.keyPackage,
    privateKeyPackage: member.privateKeyPackage,
  });
}

describe("group payload encryption", () => {
  test("round-trips plaintext and fails to decrypt under a different exporter secret", async () => {
    // Two independent groups derive different exporter secrets, mirroring
    // how a client holding the wrong epoch/group key cannot decrypt.
    const stateA = await createSoloGroupState("group-a");
    const stateB = await createSoloGroupState("group-b");

    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const { encryptedBase64 } = await encryptGroupPayload({
      state: stateA,
      serializedMlsMessage: plaintext,
    });

    // Ciphertext is not the raw plaintext.
    expect(encryptedBase64).not.toBe(encodeBase64(plaintext));

    // Same state decrypts back to the original bytes.
    const decrypted = await decryptGroupPayload({
      state: stateA,
      encryptedBase64,
    });
    expect(decrypted.serializedMlsMessage).toEqual(plaintext);

    // A different exporter secret (different group/epoch) cannot decrypt —
    // this is what naturally filters messages from epochs not yet joined.
    await expect(
      decryptGroupPayload({ state: stateB, encryptedBase64 }),
    ).rejects.toThrow();
  });

  test("every encryption produces a unique nonce (non-deterministic ciphertext)", async () => {
    const state = await createSoloGroupState("group-nonce");
    const plaintext = new Uint8Array([42, 42, 42]);

    const first = await encryptGroupPayload({
      state,
      serializedMlsMessage: plaintext,
    });
    const second = await encryptGroupPayload({
      state,
      serializedMlsMessage: plaintext,
    });

    expect(first.encryptedBase64).not.toBe(second.encryptedBase64);
    expect(
      await decryptGroupPayload({
        state,
        encryptedBase64: first.encryptedBase64,
      }),
    ).toMatchObject({ serializedMlsMessage: plaintext });
  });
});
