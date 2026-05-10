import { describe, expect, test } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import {
  createGroup,
  encode,
  keyPackageEncoder,
  mlsMessageEncoder,
  protocolVersions,
  unsafeTestingAuthenticationService,
  wireformats,
} from "ts-mls";

import { Coordinator } from "../coordinator/coordinator.ts";
import {
  createApplicationMessageBytes,
  createMemberArtifacts,
  createWelcomeForNewMember,
  createActor,
  getTestCiphersuite,
} from "../coordinator/testUtils.ts";
import { CoordinatorAdapter } from "./coordinatorMethods.ts";
import { decodeBase64 } from "./base64.ts";
import { encodeBase64 } from "./base64.ts";

function createPublicationEvent(params: {
  pubkey: string;
  secretKey: Uint8Array;
  keyPackageBase64: string;
}) {
  return finalizeEvent(
    {
      kind: 1111,
      created_at: 1_700_000_000,
      tags: [],
      content: JSON.stringify({
        params: {
          arguments: {
            keyPackageBase64: params.keyPackageBase64,
          },
        },
      }),
    },
    params.secretKey,
  );
}

function encodeWelcomeAsBase64(
  welcome: Parameters<typeof encodeWelcomeRecord>[0],
): string {
  return encodeBase64(encodeWelcomeRecord(welcome));
}

function encodeWelcomeRecord(welcome: {
  welcome: import("ts-mls").Welcome;
}): Uint8Array;
function encodeWelcomeRecord(welcome: import("ts-mls").Welcome): Uint8Array;
function encodeWelcomeRecord(
  welcome: import("ts-mls").Welcome | { welcome: import("ts-mls").Welcome },
): Uint8Array {
  const value = "welcome" in welcome ? welcome.welcome : welcome;

  return encode(mlsMessageEncoder, {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_welcome,
    welcome: value,
  });
}

function createExtra(clientPubkey?: string, requestEventId?: string) {
  return {
    _meta: clientPubkey
      ? {
          clientPubkey,
          ...(requestEventId ? { requestEventId } : {}),
        }
      : {},
  } as never;
}

describe("CoordinatorAdapter", () => {
  test("maps injected client identity into self-scoped operations", async () => {
    const coordinator = new Coordinator();
    const alice = await createMemberArtifacts(createActor("alice"));
    const publicationEvent = createPublicationEvent({
      pubkey: alice.actor.stablePubkey,
      secretKey: alice.actor.secretKey,
      keyPackageBase64: encodeBase64(
        encode(keyPackageEncoder, alice.keyPackage),
      ),
    });
    const adapter = new CoordinatorAdapter(coordinator, (requestEventId) =>
      requestEventId === publicationEvent.id ? publicationEvent : null,
    );

    const published = await adapter.publishKeyPackage(
      {
        keyPackageRef: "kp-ref-alice",
        keyPackageBase64: encodeBase64(
          encode(keyPackageEncoder, alice.keyPackage),
        ),
      },
      createExtra(alice.actor.stablePubkey, publicationEvent.id),
    );

    expect(published.content).toEqual([]);
    expect(published.structuredContent.keyPackageRef).toBe("kp-ref-alice");

    const consumed = adapter.consumeKeyPackage({
      identifier: alice.actor.stablePubkey,
    });

    expect(consumed.content).toEqual([]);
    expect(consumed.structuredContent.keyPackage?.stablePubkey).toBe(
      alice.actor.stablePubkey,
    );
    expect(consumed.structuredContent.keyPackage?.keyPackageRef).toBe(
      "kp-ref-alice",
    );
    expect(
      consumed.structuredContent.keyPackage?.publicationEvent,
    ).toMatchObject({
      id: publicationEvent.id,
      pubkey: publicationEvent.pubkey,
      created_at: publicationEvent.created_at,
      kind: publicationEvent.kind,
      tags: publicationEvent.tags,
      content: publicationEvent.content,
      sig: publicationEvent.sig,
    });
  });

  test("lists available key packages without consuming them", async () => {
    const coordinator = new Coordinator();
    const alice = await createMemberArtifacts(createActor("alice"));
    const bob = await createMemberArtifacts(createActor("bob"));
    const aliceEvent = createPublicationEvent({
      pubkey: alice.actor.stablePubkey,
      secretKey: alice.actor.secretKey,
      keyPackageBase64: encodeBase64(
        encode(keyPackageEncoder, alice.keyPackage),
      ),
    });
    const bobEvent = createPublicationEvent({
      pubkey: bob.actor.stablePubkey,
      secretKey: bob.actor.secretKey,
      keyPackageBase64: encodeBase64(encode(keyPackageEncoder, bob.keyPackage)),
    });
    const adapter = new CoordinatorAdapter(coordinator, (requestEventId) => {
      if (requestEventId === aliceEvent.id) {
        return aliceEvent;
      }

      if (requestEventId === bobEvent.id) {
        return bobEvent;
      }

      return null;
    });

    await adapter.publishKeyPackage(
      {
        keyPackageRef: "kp-ref-alice",
        keyPackageBase64: encodeBase64(
          encode(keyPackageEncoder, alice.keyPackage),
        ),
      },
      createExtra(alice.actor.stablePubkey, aliceEvent.id),
    );

    await adapter.publishKeyPackage(
      {
        keyPackageRef: "kp-ref-bob",
        keyPackageBase64: encodeBase64(
          encode(keyPackageEncoder, bob.keyPackage),
        ),
      },
      createExtra(bob.actor.stablePubkey, bobEvent.id),
    );

    const listed = adapter.listAvailableKeyPackages({});

    expect(listed.content).toEqual([]);
    expect(listed.structuredContent.keyPackages).toHaveLength(2);
    expect(
      listed.structuredContent.keyPackages.map((entry) => entry.stablePubkey),
    ).toEqual([alice.actor.stablePubkey, bob.actor.stablePubkey]);

    const consumed = adapter.consumeKeyPackage({
      identifier: alice.actor.stablePubkey,
    });
    expect(consumed.structuredContent.keyPackage?.stablePubkey).toBe(
      alice.actor.stablePubkey,
    );
  });

  test("removes only caller-owned key packages", async () => {
    const coordinator = new Coordinator();
    const alice = await createMemberArtifacts(createActor("alice-remove"));
    const bob = await createMemberArtifacts(createActor("bob-remove"));
    const aliceEvent = createPublicationEvent({
      pubkey: alice.actor.stablePubkey,
      secretKey: alice.actor.secretKey,
      keyPackageBase64: encodeBase64(
        encode(keyPackageEncoder, alice.keyPackage),
      ),
    });
    const bobEvent = createPublicationEvent({
      pubkey: bob.actor.stablePubkey,
      secretKey: bob.actor.secretKey,
      keyPackageBase64: encodeBase64(encode(keyPackageEncoder, bob.keyPackage)),
    });
    const adapter = new CoordinatorAdapter(coordinator, (requestEventId) => {
      if (requestEventId === aliceEvent.id) {
        return aliceEvent;
      }

      if (requestEventId === bobEvent.id) {
        return bobEvent;
      }

      return null;
    });

    await adapter.publishKeyPackage(
      {
        keyPackageRef: "kp-ref-alice-remove",
        keyPackageBase64: encodeBase64(
          encode(keyPackageEncoder, alice.keyPackage),
        ),
      },
      createExtra(alice.actor.stablePubkey, aliceEvent.id),
    );
    await adapter.publishKeyPackage(
      {
        keyPackageRef: "kp-ref-bob-remove",
        keyPackageBase64: encodeBase64(
          encode(keyPackageEncoder, bob.keyPackage),
        ),
      },
      createExtra(bob.actor.stablePubkey, bobEvent.id),
    );

    expect(
      adapter.removeKeyPackages(
        { keyPackageRefs: ["kp-ref-alice-remove"] },
        createExtra(alice.actor.stablePubkey),
      ).structuredContent.removedKeyPackageRefs,
    ).toEqual(["kp-ref-alice-remove"]);
    expect(coordinator.getKeyPackage("kp-ref-alice-remove")).toBeNull();
    expect(() =>
      adapter.removeKeyPackages(
        { keyPackageRefs: ["kp-ref-bob-remove"] },
        createExtra(alice.actor.stablePubkey),
      ),
    ).toThrow("Unauthorized key package ref: kp-ref-bob-remove");
    expect(() =>
      adapter.removeKeyPackages(
        { keyPackageRefs: ["kp-ref-missing-remove"] },
        createExtra(alice.actor.stablePubkey),
      ),
    ).toThrow("Unknown key package ref: kp-ref-missing-remove");
  });

  test("rejects missing injected client pubkey on self-scoped operations", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator);
    const alice = await createMemberArtifacts(createActor("alice"));

    await expect(
      adapter.publishKeyPackage(
        {
          keyPackageRef: "kp-ref-alice",
          keyPackageBase64: encodeBase64(
            encode(keyPackageEncoder, alice.keyPackage),
          ),
        },
        createExtra(),
      ),
    ).rejects.toThrowError("Missing injected client pubkey");
  });

  test("rejects invalid base64 and malformed payloads", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator);
    const alice = await createMemberArtifacts(createActor("alice"));

    await expect(
      adapter.publishKeyPackage(
        {
          keyPackageRef: "kp-ref-alice",
          keyPackageBase64: "!!!",
        },
        createExtra(alice.actor.stablePubkey),
      ),
    ).rejects.toThrowError("Invalid keyPackageBase64");

    expect(() =>
      adapter.postGroupMessage(
        {
          opaqueMessageBase64: encodeBase64(Uint8Array.from([1, 2, 3])),
        },
        createExtra(alice.actor.stablePubkey),
      ),
    ).toThrowError("Invalid opaqueMessageBase64");
  });

  test("round-trips welcomes and queued group messages as base64 structured outputs", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator);
    const alice = await createMemberArtifacts(createActor("alice"));
    const bob = await createMemberArtifacts(createActor("bob"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-alice-bob"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });

    const group = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bob,
    });

    const stored = adapter.storeWelcome({
      targetStablePubkey: bob.actor.stablePubkey,
      keyPackageReference: group.keyPackageRefHex,
      welcomeBase64: encodeWelcomeAsBase64(group.welcome),
    });

    expect(stored.content).toEqual([]);
    expect(stored.structuredContent.createdAt).toBeTypeOf("number");

    const fetchedWelcomes = adapter.fetchPendingWelcomes(
      {},
      createExtra(bob.actor.stablePubkey),
    );
    expect(fetchedWelcomes.structuredContent.welcomes).toHaveLength(1);
    expect(
      fetchedWelcomes.structuredContent.welcomes[0]?.keyPackageReference,
    ).toBe(group.keyPackageRefHex);

    const messageBytes = await createApplicationMessageBytes({
      state: group.senderState,
      plaintext: "hello from alice",
    });

    const posted = adapter.postGroupMessage(
      {
        opaqueMessageBase64: encodeBase64(messageBytes.encodedMessage),
      },
      createExtra(alice.actor.stablePubkey),
    );

    expect(posted.content).toEqual([]);

    const fetchedMessages = adapter.fetchGroupMessages({
      groupId: posted.structuredContent.groupId,
    });

    expect(fetchedMessages.content).toEqual([]);
    expect(fetchedMessages.structuredContent.messages).toHaveLength(1);
    expect(
      fetchedMessages.structuredContent.messages[0]?.opaqueMessageBase64,
    ).toBe(encodeBase64(messageBytes.encodedMessage));
  });

  test("streams backlog and live group messages as JSON chunks", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator);
    const alice = await createMemberArtifacts(createActor("alice-stream"));
    const bob = await createMemberArtifacts(createActor("bob-stream"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-streaming"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });

    const group = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bob,
    });

    const backlogMessageBytes = await createApplicationMessageBytes({
      state: group.senderState,
      plaintext: "backlog message",
    });

    const backlogPosted = adapter.postGroupMessage(
      {
        opaqueMessageBase64: encodeBase64(backlogMessageBytes.encodedMessage),
      },
      createExtra(alice.actor.stablePubkey),
    );

    const writtenChunks: string[] = [];
    let closed = false;
    let abortedReason: string | undefined;
    const stopError = new Error("stop after two chunks");

    const subscribePromise = adapter.subscribeGroupMessages(
      {
        groupId: backlogPosted.structuredContent.groupId,
        afterCursor: 0,
      },
      {
        _meta: {
          stream: {
            async start() {},
            async write(data: string) {
              writtenChunks.push(data);
              if (writtenChunks.length >= 2) {
                throw stopError;
              }
            },
            async close() {
              closed = true;
            },
            async abort(reason?: string) {
              abortedReason = reason;
            },
          },
        },
      } as never,
    );

    await Promise.resolve();

    expect(writtenChunks).toHaveLength(1);

    const liveMessageBytes = await createApplicationMessageBytes({
      state: backlogMessageBytes.newState,
      plaintext: "live message",
    });

    const livePosted = adapter.postGroupMessage(
      {
        opaqueMessageBase64: encodeBase64(liveMessageBytes.encodedMessage),
      },
      createExtra(alice.actor.stablePubkey),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(writtenChunks).toHaveLength(2);

    const parsedFirst = JSON.parse(writtenChunks[0] ?? "{}");
    const parsedSecond = JSON.parse(writtenChunks[1] ?? "{}");

    expect(parsedFirst).toMatchObject({
      cursor: 1,
      groupId: backlogPosted.structuredContent.groupId,
      createdAt: expect.any(Number),
    });
    expect(decodeBase64(parsedFirst.opaqueMessageBase64)).toEqual(
      backlogMessageBytes.encodedMessage,
    );

    expect(parsedSecond).toMatchObject({
      cursor: livePosted.structuredContent.cursor,
      groupId: livePosted.structuredContent.groupId,
      createdAt: expect.any(Number),
    });
    expect(decodeBase64(parsedSecond.opaqueMessageBase64)).toEqual(
      liveMessageBytes.encodedMessage,
    );

    expect(closed).toBe(false);
    await expect(subscribePromise).rejects.toBe(stopError);
    expect(abortedReason).toBe("stop after two chunks");
  });
});
