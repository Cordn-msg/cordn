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
  createPrivateMessage,
  getTestCiphersuite,
} from "../coordinator/testUtils.ts";
import { CoordinatorAdapter } from "./coordinatorMethods.ts";
import { encodeBase64 } from "./base64.ts";
import type { ServerLogger } from "./logger.ts";
import { subscribeManyGroupMessagesInputSchema } from "../contracts/index.ts";

const TEST_ABUSE_PROTECTION = {
  rateLimit: {
    enabled: true,
    refillPerMinute: 500,
    burst: 160,
    idleTtlMs: 3_600_000,
  },
  keyPackageQuota: {
    maxPerIdentity: 50,
    maxLastResortPerIdentity: 1,
  },
  logRejections: false,
} as const;

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
            kp_64: params.keyPackageBase64,
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

function createTestLogger(): {
  logger: ServerLogger;
  entries: Array<{
    level: "debug" | "info" | "warn" | "error";
    bindings: Record<string, unknown>;
    message: string;
  }>;
} {
  const entries: Array<{
    level: "debug" | "info" | "warn" | "error";
    bindings: Record<string, unknown>;
    message: string;
  }> = [];

  return {
    entries,
    logger: {
      debug(bindings, message) {
        entries.push({ level: "debug", bindings, message });
      },
      info(bindings, message) {
        entries.push({ level: "info", bindings, message });
      },
      warn(bindings, message) {
        entries.push({ level: "warn", bindings, message });
      },
      error(bindings, message) {
        entries.push({ level: "error", bindings, message });
      },
    },
  };
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
        kp_ref: "kp-ref-alice",
        kp_64: encodeBase64(encode(keyPackageEncoder, alice.keyPackage)),
      },
      createExtra(alice.actor.stablePubkey, publicationEvent.id),
    );

    expect(published.content).toEqual([]);
    expect(published.structuredContent.kp_ref).toBe("kp-ref-alice");

    const consumed = adapter.consumeKeyPackage({
      id: alice.actor.stablePubkey,
    });

    expect(consumed.content).toEqual([]);
    expect(consumed.structuredContent.keyPackage?.pk).toBe(
      alice.actor.stablePubkey,
    );
    expect(consumed.structuredContent.keyPackage?.kp_ref).toBe("kp-ref-alice");
    expect(consumed.structuredContent.keyPackage?.event).toMatchObject({
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
        kp_ref: "kp-ref-alice",
        kp_64: encodeBase64(encode(keyPackageEncoder, alice.keyPackage)),
      },
      createExtra(alice.actor.stablePubkey, aliceEvent.id),
    );

    await adapter.publishKeyPackage(
      {
        kp_ref: "kp-ref-bob",
        kp_64: encodeBase64(encode(keyPackageEncoder, bob.keyPackage)),
      },
      createExtra(bob.actor.stablePubkey, bobEvent.id),
    );

    const listed = adapter.listAvailableKeyPackages({});

    expect(listed.content).toEqual([]);
    expect(listed.structuredContent.keyPackages).toHaveLength(2);
    expect(
      listed.structuredContent.keyPackages.map((entry) => entry.pk),
    ).toEqual([alice.actor.stablePubkey, bob.actor.stablePubkey]);

    const consumed = adapter.consumeKeyPackage({
      id: alice.actor.stablePubkey,
    });
    expect(consumed.structuredContent.keyPackage?.pk).toBe(
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
        kp_ref: "kp-ref-alice-remove",
        kp_64: encodeBase64(encode(keyPackageEncoder, alice.keyPackage)),
      },
      createExtra(alice.actor.stablePubkey, aliceEvent.id),
    );
    await adapter.publishKeyPackage(
      {
        kp_ref: "kp-ref-bob-remove",
        kp_64: encodeBase64(encode(keyPackageEncoder, bob.keyPackage)),
      },
      createExtra(bob.actor.stablePubkey, bobEvent.id),
    );

    expect(
      adapter.removeKeyPackages(
        { kp_refs: ["kp-ref-alice-remove"] },
        createExtra(alice.actor.stablePubkey),
      ).structuredContent.kp_refs,
    ).toEqual(["kp-ref-alice-remove"]);
    expect(coordinator.getKeyPackage("kp-ref-alice-remove")).toBeNull();
    expect(() =>
      adapter.removeKeyPackages(
        { kp_refs: ["kp-ref-bob-remove"] },
        createExtra(alice.actor.stablePubkey),
      ),
    ).toThrow("Unauthorized key package ref: kp-ref-bob-remove");
    expect(() =>
      adapter.removeKeyPackages(
        { kp_refs: ["kp-ref-missing-remove"] },
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
          kp_ref: "kp-ref-alice",
          kp_64: encodeBase64(encode(keyPackageEncoder, alice.keyPackage)),
        },
        createExtra(),
      ),
    ).rejects.toThrow("Missing injected client pubkey");
  });

  test("rejects invalid base64 and malformed payloads", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator);
    const alice = await createMemberArtifacts(createActor("alice"));

    await expect(
      adapter.publishKeyPackage(
        {
          kp_ref: "kp-ref-alice",
          kp_64: "!!!",
        },
        createExtra(alice.actor.stablePubkey),
      ),
    ).rejects.toThrow("Invalid kp_64");
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
      target_pk: bob.actor.stablePubkey,
      kp_ref: group.keyPackageRefHex,
      welcome_64: encodeWelcomeAsBase64(group.welcome),
    });

    expect(stored.content).toEqual([]);
    expect(stored.structuredContent.at).toBeTypeOf("number");

    const fetchedWelcomes = adapter.fetchPendingWelcomes(
      {},
      createExtra(bob.actor.stablePubkey),
    );
    expect(fetchedWelcomes.structuredContent.welcomes).toHaveLength(1);
    expect(fetchedWelcomes.structuredContent.welcomes[0]?.kp_ref).toBe(
      group.keyPackageRefHex,
    );

    const messageBytes = await createApplicationMessageBytes({
      state: group.senderState,
      plaintext: "hello from alice",
    });

    const posted = adapter.postGroupMessage({
      gid: "group-alice-bob",
      msg_64: encodeBase64(messageBytes.encodedMessage),
    });

    expect(posted.content).toEqual([]);

    const fetchedMessages = adapter.fetchManyGroupMessages({
      groups: [{ gid: posted.structuredContent.gid }],
    });

    expect(fetchedMessages.content).toEqual([]);
    expect(fetchedMessages.structuredContent.messages).toHaveLength(1);
    expect(fetchedMessages.structuredContent.messages[0]?.msg_64).toBe(
      encodeBase64(messageBytes.encodedMessage),
    );

    const fetchedManyMessages = adapter.fetchManyGroupMessages({
      groups: [{ gid: posted.structuredContent.gid, after: 0 }],
    });

    expect(fetchedManyMessages.content).toEqual([]);
    expect(fetchedManyMessages.structuredContent.messages).toHaveLength(1);
    expect(fetchedManyMessages.structuredContent.messages[0]).toMatchObject({
      cursor: posted.structuredContent.cursor,
      gid: posted.structuredContent.gid,
      msg_64: encodeBase64(messageBytes.encodedMessage),
    });
  });

  test("round-trips gid through postGroupMessage contract", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator);

    // Post with gid → coordinator uses encrypted path (skips MLS decoding).
    const encryptedOpaque = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const posted = adapter.postGroupMessage({
      gid: "encrypted-topic",
      msg_64: encodeBase64(encryptedOpaque),
    });

    expect(posted.content).toEqual([]);
    expect(posted.structuredContent.gid).toBe("encrypted-topic");
    expect(posted.structuredContent.cursor).toBe(1);
    expect(posted.structuredContent.at).toBeTypeOf("number");

    // Fetch returns the posted message.
    const fetched = adapter.fetchManyGroupMessages({
      groups: [{ gid: "encrypted-topic" }],
    });
    expect(fetched.structuredContent.messages).toHaveLength(1);
    expect(fetched.structuredContent.messages[0]).toMatchObject({
      gid: "encrypted-topic",
      msg_64: encodeBase64(encryptedOpaque),
    });
  });

  test("round-trips welcome after cursor hint through store/fetch contract", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator);
    const alice = await createMemberArtifacts(
      createActor("alice-welcome-after"),
    );
    const bob = await createMemberArtifacts(createActor("bob-welcome-after"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-welcome-after"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });
    const fixture = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bob,
    });

    // Store with after cursor hint.
    adapter.storeWelcome({
      target_pk: bob.actor.stablePubkey,
      kp_ref: fixture.keyPackageRefHex,
      welcome_64: encodeWelcomeAsBase64(fixture.welcome),
      after: 42,
    });

    // Fetch returns the after cursor.
    const fetched = adapter.fetchPendingWelcomes(
      {},
      createExtra(bob.actor.stablePubkey),
    );
    expect(fetched.structuredContent.welcomes).toHaveLength(1);
    expect(fetched.structuredContent.welcomes[0]).toMatchObject({
      kp_ref: fixture.keyPackageRefHex,
      after: 42,
    });

    // Old-style welcome without after returns undefined (backward compat).
    adapter.storeWelcome({
      target_pk: bob.actor.stablePubkey,
      kp_ref: "no-after-ref",
      welcome_64: encodeWelcomeAsBase64(fixture.welcome),
    });
    const secondFetch = adapter.fetchPendingWelcomes(
      {},
      createExtra(bob.actor.stablePubkey),
    );
    const withoutAfter = secondFetch.structuredContent.welcomes.find(
      (w) => w.kp_ref === "no-after-ref",
    );
    expect(withoutAfter?.after).toBeUndefined();
  });

  test("retires a welcome via the consumed ack on fetchPendingWelcomes", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator);
    const alice = await createMemberArtifacts(createActor("alice-consume"));
    const bob = await createMemberArtifacts(createActor("bob-consume"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-consume"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });
    const fixture = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bob,
    });

    adapter.storeWelcome({
      target_pk: bob.actor.stablePubkey,
      kp_ref: fixture.keyPackageRefHex,
      welcome_64: encodeWelcomeAsBase64(fixture.welcome),
    });

    const observed = adapter.fetchPendingWelcomes(
      {},
      createExtra(bob.actor.stablePubkey),
    );
    expect(observed.structuredContent.welcomes).toHaveLength(1);
    const welcome = observed.structuredContent.welcomes[0]!;

    // Echo the consumed ref back; the welcome is retired and not returned.
    const after = adapter.fetchPendingWelcomes(
      { consumed: [{ kp_ref: welcome.kp_ref, at: welcome.at }] },
      createExtra(bob.actor.stablePubkey),
    );
    expect(after.structuredContent.welcomes).toHaveLength(0);
  });

  test("round-trips join requests with validation and deduplication", async () => {
    const coordinator = new Coordinator();
    const alice = await createMemberArtifacts(createActor("alice-join-req"));
    const bob = await createMemberArtifacts(createActor("bob-join-req"));
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
      if (requestEventId === aliceEvent.id) return aliceEvent;
      if (requestEventId === bobEvent.id) return bobEvent;
      return null;
    });

    // Publish key packages for alice and bob.
    await adapter.publishKeyPackage(
      {
        kp_ref: "kp-ref-alice-join",
        kp_64: encodeBase64(encode(keyPackageEncoder, alice.keyPackage)),
      },
      createExtra(alice.actor.stablePubkey, aliceEvent.id),
    );
    await adapter.publishKeyPackage(
      {
        kp_ref: "kp-ref-bob-join",
        kp_64: encodeBase64(encode(keyPackageEncoder, bob.keyPackage)),
      },
      createExtra(bob.actor.stablePubkey, bobEvent.id),
    );

    // Seed a group via the coordinator so getGroupRouting finds it.
    coordinator.postGroupMessage({
      groupId: "group-join-req",
      opaqueMessage: createPrivateMessage({
        groupId: "group-join-req",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    const gid = "group-join-req";

    // Success: join request for a group with no messages (bootstrap scenario).
    // The coordinator no longer requires group existence for join requests,
    // allowing freshly created groups to accept join requests immediately.
    const bootstrapStored = adapter.storeJoinRequest(
      { gid: "brand-new-group", kp_ref: "kp-ref-alice-join" },
      createExtra(alice.actor.stablePubkey),
    );
    expect(bootstrapStored.structuredContent.at).toBeTypeOf("number");

    // Reject: unknown key package ref.
    expect(() =>
      adapter.storeJoinRequest(
        { gid, kp_ref: "kp-ref-unknown" },
        createExtra(alice.actor.stablePubkey),
      ),
    ).toThrow("Unknown key package ref");

    // Reject: unauthorized key package ref (bob's KP, alice calling).
    expect(() =>
      adapter.storeJoinRequest(
        { gid, kp_ref: "kp-ref-bob-join" },
        createExtra(alice.actor.stablePubkey),
      ),
    ).toThrow("Unauthorized key package ref");

    // Reject: missing client pubkey.
    expect(() =>
      adapter.storeJoinRequest(
        { gid, kp_ref: "kp-ref-alice-join" },
        createExtra(),
      ),
    ).toThrow("Missing injected client pubkey");

    // Success: alice stores a join request for her own KP.
    const stored = adapter.storeJoinRequest(
      { gid, kp_ref: "kp-ref-alice-join" },
      createExtra(alice.actor.stablePubkey),
    );
    expect(stored.content).toEqual([]);
    expect(stored.structuredContent.at).toBeTypeOf("number");

    // Dedup: re-storing must not create a second row (verified downstream via
    // toHaveLength(2)). The dedup path intentionally refreshes `createdAt` in
    // place to evade an admin's recorded consume ref, so the contract here is
    // monotonic — `at` never moves backwards — not equality. Wall-clock time
    // can straddle a ms boundary on slow CI runners, so don't pin equality.
    const storedAgain = adapter.storeJoinRequest(
      { gid, kp_ref: "kp-ref-alice-join" },
      createExtra(alice.actor.stablePubkey),
    );
    expect(storedAgain.structuredContent.at).toBeGreaterThanOrEqual(
      stored.structuredContent.at,
    );

    // Bob stores his own join request.
    adapter.storeJoinRequest(
      { gid, kp_ref: "kp-ref-bob-join" },
      createExtra(bob.actor.stablePubkey),
    );

    // Fetch returns both requests.
    const fetched = adapter.fetchManyPendingJoinRequests({ groups: [{ gid }] });
    expect(fetched.content).toEqual([]);
    expect(fetched.structuredContent.requests).toHaveLength(2);
    expect(fetched.structuredContent.requests[0]?.pk).toBe(
      alice.actor.stablePubkey,
    );
    expect(fetched.structuredContent.requests[0]?.kp_ref).toBe(
      "kp-ref-alice-join",
    );
    expect(fetched.structuredContent.requests[1]?.pk).toBe(
      bob.actor.stablePubkey,
    );
    expect(fetched.structuredContent.requests[1]?.kp_ref).toBe(
      "kp-ref-bob-join",
    );
  });

  test("retires a join request via the consumed ack on fetchPendingJoinRequests", async () => {
    const coordinator = new Coordinator();
    const alice = await createMemberArtifacts(createActor("alice-join-ack"));
    const bob = await createMemberArtifacts(createActor("bob-join-ack"));
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
      if (requestEventId === aliceEvent.id) return aliceEvent;
      if (requestEventId === bobEvent.id) return bobEvent;
      return null;
    });
    await adapter.publishKeyPackage(
      {
        kp_ref: "kp-ref-alice-ack",
        kp_64: encodeBase64(encode(keyPackageEncoder, alice.keyPackage)),
      },
      createExtra(alice.actor.stablePubkey, aliceEvent.id),
    );
    await adapter.publishKeyPackage(
      {
        kp_ref: "kp-ref-bob-ack",
        kp_64: encodeBase64(encode(keyPackageEncoder, bob.keyPackage)),
      },
      createExtra(bob.actor.stablePubkey, bobEvent.id),
    );

    const gid = "group-join-ack";
    adapter.storeJoinRequest(
      { gid, kp_ref: "kp-ref-alice-ack" },
      createExtra(alice.actor.stablePubkey),
    );
    adapter.storeJoinRequest(
      { gid, kp_ref: "kp-ref-bob-ack" },
      createExtra(bob.actor.stablePubkey),
    );

    const observed = adapter.fetchManyPendingJoinRequests({
      groups: [{ gid }],
    });
    expect(observed.structuredContent.requests).toHaveLength(2);
    const aliceReq = observed.structuredContent.requests.find(
      (r) => r.pk === alice.actor.stablePubkey,
    )!;

    // Ack alice's request; only bob's remains.
    const after = adapter.fetchManyPendingJoinRequests({
      groups: [{ gid }],
      consumed: [{ gid, pk: aliceReq.pk, at: aliceReq.at }],
    });
    expect(after.structuredContent.requests).toHaveLength(1);
    expect(after.structuredContent.requests[0]?.pk).toBe(
      bob.actor.stablePubkey,
    );
  });

  test("returns fetch output shape without runtime schema parsing", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator);
    const alice = await createMemberArtifacts(createActor("alice-fetch-shape"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-fetch-shape"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });

    const messageBytes = await createApplicationMessageBytes({
      state: aliceState,
      plaintext: "shape-check",
    });

    const posted = adapter.postGroupMessage({
      gid: "group-fetch-shape",
      msg_64: encodeBase64(messageBytes.encodedMessage),
    });

    const fetchedMessages = adapter.fetchManyGroupMessages({
      groups: [{ gid: posted.structuredContent.gid }],
    });
    const message = fetchedMessages.structuredContent.messages[0];

    expect(message).toEqual({
      cursor: 1,
      gid: posted.structuredContent.gid,
      msg_64: encodeBase64(messageBytes.encodedMessage),
      at: expect.any(Number),
    });
  });

  test("multi-group subscription replays backlog with independent cursors and streams live messages", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator);
    const alice = await createMemberArtifacts(createActor("alice-many-sub"));
    const cipherSuite = await getTestCiphersuite();
    const firstState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-many-sub-a"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });
    const secondState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-many-sub-b"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });

    const firstBacklog = await createApplicationMessageBytes({
      state: firstState,
      plaintext: "first backlog",
    });
    const secondSkipped = await createApplicationMessageBytes({
      state: secondState,
      plaintext: "second skipped",
    });
    const secondBacklog = await createApplicationMessageBytes({
      state: secondSkipped.newState,
      plaintext: "second backlog",
    });

    const firstPosted = adapter.postGroupMessage({
      gid: "alpha",
      msg_64: encodeBase64(firstBacklog.encodedMessage),
    });
    const secondSkippedPosted = adapter.postGroupMessage({
      gid: "beta",
      msg_64: encodeBase64(secondSkipped.encodedMessage),
    });
    const secondPosted = adapter.postGroupMessage({
      gid: "beta",
      msg_64: encodeBase64(secondBacklog.encodedMessage),
    });

    const writtenChunks: string[] = [];
    const stream = {
      isActive: true,
      signal: new AbortController().signal,
      async start() {},
      async write(data: string) {
        writtenChunks.push(data);
      },
      async close() {
        this.isActive = false;
      },
      async abort(_reason?: string) {
        this.isActive = false;
      },
    };

    const subscribePromise = adapter.subscribeManyGroupMessages(
      {
        groups: [
          { gid: firstPosted.structuredContent.gid, after: 0 },
          {
            gid: secondPosted.structuredContent.gid,
            after: secondSkippedPosted.structuredContent.cursor,
          },
        ],
      },
      { _meta: { stream } } as never,
    );

    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writtenChunks.map((chunk) => JSON.parse(chunk))).toMatchObject([
      { gid: firstPosted.structuredContent.gid, cursor: 1 },
      { gid: secondPosted.structuredContent.gid, cursor: 2 },
    ]);

    const firstLive = await createApplicationMessageBytes({
      state: firstBacklog.newState,
      plaintext: "first live",
    });
    const firstLivePosted = adapter.postGroupMessage({
      gid: "alpha",
      msg_64: encodeBase64(firstLive.encodedMessage),
    });

    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await stream.abort("stop multi");

    await expect(subscribePromise).resolves.toMatchObject({
      structuredContent: {
        subscribed: true,
        groups: [
          firstPosted.structuredContent.gid,
          secondPosted.structuredContent.gid,
        ],
      },
    });
    expect(writtenChunks.map((chunk) => JSON.parse(chunk))).toMatchObject([
      { gid: firstPosted.structuredContent.gid, cursor: 1 },
      { gid: secondPosted.structuredContent.gid, cursor: 2 },
      { gid: firstLivePosted.structuredContent.gid, cursor: 2 },
    ]);
    expect(coordinator.getActiveSubscriptionCount()).toBe(0);
  });

  test("multi-group subscription subscribes before backlog fetch to preserve setup-race messages", async () => {
    const coordinator = new Coordinator();
    const alice = await createMemberArtifacts(createActor("alice-many-race"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-many-race"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });

    const firstMessage = await createApplicationMessageBytes({
      state: aliceState,
      plaintext: "multi seed",
    });

    coordinator.postGroupMessage({
      groupId: "group-many-race",
      opaqueMessage: firstMessage.encodedMessage,
    });

    let secondMessageBytes: Uint8Array | null = null;
    const originalFetchManyGroupMessages =
      coordinator.fetchManyGroupMessages.bind(coordinator);
    coordinator.fetchManyGroupMessages = ((input) => {
      if (
        input.groups.some((group) => group.groupId === "group-many-race") &&
        secondMessageBytes
      ) {
        coordinator.postGroupMessage({
          groupId: "group-many-race",
          opaqueMessage: secondMessageBytes,
        });
        secondMessageBytes = null;
      }

      return originalFetchManyGroupMessages(input);
    }) as typeof coordinator.fetchManyGroupMessages;

    const secondMessage = await createApplicationMessageBytes({
      state: firstMessage.newState,
      plaintext: "multi during setup",
    });
    secondMessageBytes = secondMessage.encodedMessage;

    const adapter = new CoordinatorAdapter(coordinator);
    const writtenChunks: string[] = [];
    const stream = {
      isActive: true,
      signal: new AbortController().signal,
      async start() {},
      async write(data: string) {
        writtenChunks.push(data);
        if (writtenChunks.length >= 2) {
          this.isActive = false;
        }
      },
      async close() {
        this.isActive = false;
      },
      async abort(_reason?: string) {
        this.isActive = false;
      },
    };

    const subscribePromise = adapter.subscribeManyGroupMessages(
      { groups: [{ gid: "group-many-race", after: 0 }] },
      { _meta: { stream } } as never,
    );

    for (
      let attempt = 0;
      attempt < 10 && writtenChunks.length < 2;
      attempt += 1
    ) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await stream.abort();

    await expect(subscribePromise).resolves.toMatchObject({
      structuredContent: { subscribed: true, groups: ["group-many-race"] },
    });
    expect(writtenChunks).toHaveLength(2);
    expect(JSON.parse(writtenChunks[0] ?? "{}")).toMatchObject({ cursor: 1 });
    expect(JSON.parse(writtenChunks[1] ?? "{}")).toMatchObject({ cursor: 2 });
  });

  test("multi-group subscription abort cleans up all child subscriptions", async () => {
    const coordinator = new Coordinator();
    const { logger, entries } = createTestLogger();
    const adapter = new CoordinatorAdapter(
      coordinator,
      undefined,
      undefined,
      logger,
    );
    const stream = {
      isActive: true,
      signal: new AbortController().signal,
      async start() {},
      async write() {},
      async close() {
        this.isActive = false;
      },
      async abort(_reason?: string) {
        this.isActive = false;
      },
    };

    const subscribePromise = adapter.subscribeManyGroupMessages(
      {
        groups: [{ gid: "group-abort-a" }, { gid: "group-abort-b" }],
      },
      { _meta: { stream } } as never,
    );

    await Promise.resolve();
    expect(coordinator.getActiveSubscriptionCount()).toBe(1);
    await stream.abort("user stop many");

    await expect(subscribePromise).resolves.toMatchObject({
      structuredContent: {
        subscribed: true,
        groups: ["group-abort-a", "group-abort-b"],
      },
    });
    expect(coordinator.getActiveSubscriptionCount()).toBe(0);
    expect(
      entries.find((entry) => entry.bindings.type === "subscription_end")
        ?.bindings,
    ).toMatchObject({
      groupIds: ["group-abort-a", "group-abort-b"],
      groupCount: 2,
      reason: "user stop many",
    });
  });

  test("removes subscriber when the writer signal aborts (silent client disconnect)", async () => {
    const coordinator = new Coordinator();
    const { logger, entries } = createTestLogger();
    const adapter = new CoordinatorAdapter(
      coordinator,
      undefined,
      undefined,
      logger,
    );
    const controller = new AbortController();
    const stream = {
      isActive: true,
      signal: controller.signal,
      async start() {},
      async write() {},
      async close() {
        this.isActive = false;
      },
      async abort(_reason?: string) {
        this.isActive = false;
      },
    };

    const subscribePromise = adapter.subscribeManyGroupMessages(
      { groups: [{ gid: "group-signal-disconnect" }] },
      { _meta: { stream } } as never,
    );

    await Promise.resolve();
    // Simulate the SDK firing the writer signal on a silent client disconnect
    // (dispose/probe-timeout), the path the stream.abort override does not cover.
    controller.abort();

    await expect(subscribePromise).resolves.toMatchObject({
      structuredContent: {
        subscribed: true,
        groups: ["group-signal-disconnect"],
      },
    });
    expect(coordinator.getActiveSubscriptionCount()).toBe(0);

    expect(
      entries.find((entry) => entry.bindings.type === "subscription_end")
        ?.bindings,
    ).toMatchObject({
      reason: "client-disconnect",
    });
  });

  test("multi-group subscription ignores messages from unsubscribed groups", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator);
    const alice = await createMemberArtifacts(
      createActor("alice-many-isolate"),
    );
    const cipherSuite = await getTestCiphersuite();
    const subscribedState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-many-isolate-a"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });
    const otherState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-many-isolate-c"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });

    const writtenChunks: string[] = [];
    const stream = {
      isActive: true,
      signal: new AbortController().signal,
      async start() {},
      async write(data: string) {
        writtenChunks.push(data);
      },
      async close() {
        this.isActive = false;
      },
      async abort(_reason?: string) {
        this.isActive = false;
      },
    };

    const subscribePromise = adapter.subscribeManyGroupMessages(
      {
        groups: [
          { gid: "group-many-isolate-a" },
          { gid: "group-many-isolate-b" },
        ],
      },
      { _meta: { stream } } as never,
    );

    await Promise.resolve();
    expect(coordinator.getActiveSubscriptionCount()).toBe(1);

    const otherMessage = await createApplicationMessageBytes({
      state: otherState,
      plaintext: "should not cross-talk",
    });
    adapter.postGroupMessage({
      gid: "group-many-isolate-c",
      msg_64: encodeBase64(otherMessage.encodedMessage),
    });

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writtenChunks).toHaveLength(0);

    const subscribedMessage = await createApplicationMessageBytes({
      state: subscribedState,
      plaintext: "subscribed live",
    });
    const subscribedPosted = adapter.postGroupMessage({
      gid: "group-many-isolate-a",
      msg_64: encodeBase64(subscribedMessage.encodedMessage),
    });

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await stream.abort("done isolation");

    await expect(subscribePromise).resolves.toMatchObject({
      structuredContent: { subscribed: true },
    });
    expect(writtenChunks.map((chunk) => JSON.parse(chunk))).toMatchObject([
      { gid: subscribedPosted.structuredContent.gid, cursor: 1 },
    ]);
    expect(coordinator.getActiveSubscriptionCount()).toBe(0);
  });

  test("multi-group subscription schema rejects empty group lists and malformed entries", () => {
    expect(() =>
      subscribeManyGroupMessagesInputSchema.parse({ groups: [{}] }),
    ).toThrow();
    expect(() =>
      subscribeManyGroupMessagesInputSchema.parse({ groups: [{ gid: "" }] }),
    ).toThrow();
    expect(() =>
      subscribeManyGroupMessagesInputSchema.parse({
        groups: [{ gid: "group", after: -1 }],
      }),
    ).toThrow();
    expect(
      subscribeManyGroupMessagesInputSchema.parse({
        groups: [{ gid: "group", after: 1 }],
      }),
    ).toEqual({ groups: [{ gid: "group", after: 1 }] });
  });

  test("rejects requests once the token bucket burst is exhausted", async () => {
    const coordinator = new Coordinator();
    const adapter = new CoordinatorAdapter(coordinator, undefined, {
      ...TEST_ABUSE_PROTECTION,
      rateLimit: {
        enabled: true,
        refillPerMinute: 0,
        burst: 2,
        idleTtlMs: 3_600_000,
      },
    });
    const alice = await createMemberArtifacts(createActor("alice-rate-limit"));

    expect(() =>
      adapter.assertWithinRateLimit(
        createExtra(alice.actor.stablePubkey),
        "kp_list",
      ),
    ).not.toThrow();
    expect(() =>
      adapter.assertWithinRateLimit(
        createExtra(alice.actor.stablePubkey),
        "kp_list",
      ),
    ).not.toThrow();
    expect(() =>
      adapter.assertWithinRateLimit(
        createExtra(alice.actor.stablePubkey),
        "kp_list",
      ),
    ).toThrow("Rate limit exceeded");
  });

  test("logs rate limit rejections through the injected logger", async () => {
    const coordinator = new Coordinator();
    const { logger, entries } = createTestLogger();
    const adapter = new CoordinatorAdapter(
      coordinator,
      undefined,
      {
        ...TEST_ABUSE_PROTECTION,
        rateLimit: {
          enabled: true,
          refillPerMinute: 0,
          burst: 1,
          idleTtlMs: 3_600_000,
        },
        logRejections: true,
      },
      logger,
    );
    const alice = await createMemberArtifacts(
      createActor("alice-rate-limit-log"),
    );

    adapter.assertWithinRateLimit(
      createExtra(alice.actor.stablePubkey),
      "kp_list",
    );

    expect(() =>
      adapter.assertWithinRateLimit(
        createExtra(alice.actor.stablePubkey),
        "kp_list",
      ),
    ).toThrow("Rate limit exceeded");

    expect(entries).toContainEqual({
      level: "warn",
      message: "cordn abuse protection rejection",
      bindings: {
        type: "rate_limit",
        method: "kp_list",
        clientPubkey: `${alice.actor.stablePubkey.slice(0, 12)}…`,
      },
    });
  });

  test("replaces the previous last-resort key package for the same identity", async () => {
    const coordinator = new Coordinator();
    const actor = createActor("alice-last-resort");
    const alice = await createMemberArtifacts(actor, { lastResort: true });
    const firstEvent = createPublicationEvent({
      pubkey: alice.actor.stablePubkey,
      secretKey: alice.actor.secretKey,
      keyPackageBase64: encodeBase64(
        encode(keyPackageEncoder, alice.keyPackage),
      ),
    });
    const replacement = await createMemberArtifacts(actor, {
      lastResort: true,
    });
    const replacementEvent = createPublicationEvent({
      pubkey: replacement.actor.stablePubkey,
      secretKey: replacement.actor.secretKey,
      keyPackageBase64: encodeBase64(
        encode(keyPackageEncoder, replacement.keyPackage),
      ),
    });
    const adapter = new CoordinatorAdapter(
      coordinator,
      (requestEventId) => {
        if (requestEventId === firstEvent.id) {
          return firstEvent;
        }

        if (requestEventId === replacementEvent.id) {
          return replacementEvent;
        }

        return null;
      },
      TEST_ABUSE_PROTECTION,
    );

    await adapter.publishKeyPackage(
      {
        kp_ref: "kp-ref-first-last-resort",
        kp_64: encodeBase64(encode(keyPackageEncoder, alice.keyPackage)),
      },
      createExtra(alice.actor.stablePubkey, firstEvent.id),
    );
    await adapter.publishKeyPackage(
      {
        kp_ref: "kp-ref-second-last-resort",
        kp_64: encodeBase64(encode(keyPackageEncoder, replacement.keyPackage)),
      },
      createExtra(replacement.actor.stablePubkey, replacementEvent.id),
    );

    const records = coordinator.listKeyPackagesForIdentity(
      alice.actor.stablePubkey,
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.keyPackageRef).toBe("kp-ref-second-last-resort");
    expect(records[0]?.isLastResort).toBe(true);
  });

  test("rejects publishing regular key packages beyond the configured identity quota", async () => {
    const coordinator = new Coordinator();
    const actor = createActor("alice-quota");
    const alice = await createMemberArtifacts(actor);
    const bob = await createMemberArtifacts(actor);
    const firstEvent = createPublicationEvent({
      pubkey: alice.actor.stablePubkey,
      secretKey: alice.actor.secretKey,
      keyPackageBase64: encodeBase64(
        encode(keyPackageEncoder, alice.keyPackage),
      ),
    });
    const secondEvent = createPublicationEvent({
      pubkey: bob.actor.stablePubkey,
      secretKey: bob.actor.secretKey,
      keyPackageBase64: encodeBase64(encode(keyPackageEncoder, bob.keyPackage)),
    });
    const adapter = new CoordinatorAdapter(
      coordinator,
      (requestEventId) => {
        if (requestEventId === firstEvent.id) {
          return firstEvent;
        }

        if (requestEventId === secondEvent.id) {
          return secondEvent;
        }

        return null;
      },
      {
        ...TEST_ABUSE_PROTECTION,
        keyPackageQuota: {
          maxPerIdentity: 1,
          maxLastResortPerIdentity: 1,
        },
      },
    );

    await adapter.publishKeyPackage(
      {
        kp_ref: "kp-ref-first-regular",
        kp_64: encodeBase64(encode(keyPackageEncoder, alice.keyPackage)),
      },
      createExtra(alice.actor.stablePubkey, firstEvent.id),
    );

    await expect(
      adapter.publishKeyPackage(
        {
          kp_ref: "kp-ref-second-regular",
          kp_64: encodeBase64(encode(keyPackageEncoder, bob.keyPackage)),
        },
        createExtra(bob.actor.stablePubkey, secondEvent.id),
      ),
    ).rejects.toThrow("Key package quota exceeded");
  });
});
