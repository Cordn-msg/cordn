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
    level: "info" | "warn" | "error";
    bindings: Record<string, unknown>;
    message: string;
  }>;
} {
  const entries: Array<{
    level: "info" | "warn" | "error";
    bindings: Record<string, unknown>;
    message: string;
  }> = [];

  return {
    entries,
    logger: {
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

    expect(() =>
      adapter.postGroupMessage(
        {
          msg_64: encodeBase64(Uint8Array.from([1, 2, 3])),
        },
        createExtra(alice.actor.stablePubkey),
      ),
    ).toThrow("Unable to decode MLS message");
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

    const posted = adapter.postGroupMessage(
      {
        msg_64: encodeBase64(messageBytes.encodedMessage),
      },
      createExtra(alice.actor.stablePubkey),
    );

    expect(posted.content).toEqual([]);

    const fetchedMessages = adapter.fetchGroupMessages({
      gid: posted.structuredContent.gid,
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
        msg_64: encodeBase64(backlogMessageBytes.encodedMessage),
      },
      createExtra(alice.actor.stablePubkey),
    );

    const writtenChunks: string[] = [];
    let closed = false;
    let abortedReason: string | undefined;
    const stopError = new Error("stop after two chunks");

    const subscribePromise = adapter.subscribeGroupMessages(
      {
        gid: backlogPosted.structuredContent.gid,
        after: 0,
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
        msg_64: encodeBase64(liveMessageBytes.encodedMessage),
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
      gid: backlogPosted.structuredContent.gid,
      at: expect.any(Number),
    });
    expect(decodeBase64(parsedFirst.msg_64)).toEqual(
      backlogMessageBytes.encodedMessage,
    );

    expect(parsedSecond).toMatchObject({
      cursor: livePosted.structuredContent.cursor,
      gid: livePosted.structuredContent.gid,
      at: expect.any(Number),
    });
    expect(decodeBase64(parsedSecond.msg_64)).toEqual(
      liveMessageBytes.encodedMessage,
    );

    expect(closed).toBe(false);
    await expect(subscribePromise).rejects.toBe(stopError);
    expect(abortedReason).toBe("stop after two chunks");
  });

  test("completes the subscription handler after stream abort", async () => {
    const coordinator = new Coordinator();
    const { logger, entries } = createTestLogger();
    const adapter = new CoordinatorAdapter(
      coordinator,
      undefined,
      undefined,
      logger,
    );
    const alice = await createMemberArtifacts(createActor("alice-abort"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-stream-abort"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });

    const messageBytes = await createApplicationMessageBytes({
      state: aliceState,
      plaintext: "seed",
    });

    const posted = adapter.postGroupMessage(
      {
        msg_64: encodeBase64(messageBytes.encodedMessage),
      },
      createExtra(alice.actor.stablePubkey),
    );

    let abortedReason: string | undefined;
    const stream = {
      isActive: true,
      async start() {},
      async write() {},
      async close() {
        this.isActive = false;
      },
      async abort(reason?: string) {
        abortedReason = reason;
        this.isActive = false;
      },
    };

    const subscribePromise = adapter.subscribeGroupMessages(
      {
        gid: posted.structuredContent.gid,
        after: posted.structuredContent.cursor,
      },
      {
        _meta: {
          stream,
        },
      } as never,
    );

    await Promise.resolve();
    await stream.abort("user requested stop");

    await expect(subscribePromise).resolves.toMatchObject({
      structuredContent: {
        subscribed: true,
      },
    });
    expect(abortedReason).toBe("user requested stop");
    expect(coordinator.getActiveSubscriptionCount()).toBe(0);

    const startLog = entries.find(
      (entry) => entry.bindings.type === "subscription_start",
    );
    const endLog = entries.find(
      (entry) => entry.bindings.type === "subscription_end",
    );

    expect(startLog?.bindings).toMatchObject({
      groupId: posted.structuredContent.gid,
      activeSubscriptions: 1,
    });
    expect(endLog?.bindings).toMatchObject({
      groupId: posted.structuredContent.gid,
      reason: "user requested stop",
      activeSubscriptions: 0,
    });
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

    const posted = adapter.postGroupMessage(
      {
        msg_64: encodeBase64(messageBytes.encodedMessage),
      },
      createExtra(alice.actor.stablePubkey),
    );

    const fetchedMessages = adapter.fetchGroupMessages({
      gid: posted.structuredContent.gid,
    });
    const message = fetchedMessages.structuredContent.messages[0];

    expect(message).toEqual({
      cursor: 1,
      gid: posted.structuredContent.gid,
      msg_64: encodeBase64(messageBytes.encodedMessage),
      at: expect.any(Number),
    });
  });

  test("subscribes before backlog fetch to preserve messages posted during setup", async () => {
    const coordinator = new Coordinator();
    const alice = await createMemberArtifacts(createActor("alice-race-free"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-race-free"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });

    const firstMessage = await createApplicationMessageBytes({
      state: aliceState,
      plaintext: "seed",
    });

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: alice.actor.stablePubkey,
      opaqueMessage: firstMessage.encodedMessage,
    });

    let secondMessageBytes: Uint8Array | null = null;
    const originalFetchGroupMessages =
      coordinator.fetchGroupMessages.bind(coordinator);
    coordinator.fetchGroupMessages = ((input) => {
      if (input.groupId === "group-race-free" && secondMessageBytes) {
        coordinator.postGroupMessage({
          ephemeralSenderPubkey: alice.actor.stablePubkey,
          opaqueMessage: secondMessageBytes,
        });
        secondMessageBytes = null;
      }

      return originalFetchGroupMessages(input);
    }) as typeof coordinator.fetchGroupMessages;

    const secondMessage = await createApplicationMessageBytes({
      state: firstMessage.newState,
      plaintext: "during setup",
    });
    secondMessageBytes = secondMessage.encodedMessage;

    const adapter = new CoordinatorAdapter(coordinator);
    const writtenChunks: string[] = [];
    const stream = {
      isActive: true,
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

    const subscribePromise = adapter.subscribeGroupMessages(
      {
        gid: "group-race-free",
        after: 0,
      },
      { _meta: { stream } } as never,
    );

    await Promise.resolve();
    await Promise.resolve();
    await stream.abort();

    await expect(subscribePromise).resolves.toMatchObject({
      structuredContent: { subscribed: true },
    });
    expect(writtenChunks).toHaveLength(2);
    expect(JSON.parse(writtenChunks[0] ?? "{}")).toMatchObject({ cursor: 1 });
    expect(JSON.parse(writtenChunks[1] ?? "{}")).toMatchObject({ cursor: 2 });
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

    const firstPosted = adapter.postGroupMessage(
      { msg_64: encodeBase64(firstBacklog.encodedMessage) },
      createExtra(alice.actor.stablePubkey),
    );
    const secondSkippedPosted = adapter.postGroupMessage(
      { msg_64: encodeBase64(secondSkipped.encodedMessage) },
      createExtra(alice.actor.stablePubkey),
    );
    const secondPosted = adapter.postGroupMessage(
      { msg_64: encodeBase64(secondBacklog.encodedMessage) },
      createExtra(alice.actor.stablePubkey),
    );

    const writtenChunks: string[] = [];
    const stream = {
      isActive: true,
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
    const firstLivePosted = adapter.postGroupMessage(
      { msg_64: encodeBase64(firstLive.encodedMessage) },
      createExtra(alice.actor.stablePubkey),
    );

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
      ephemeralSenderPubkey: alice.actor.stablePubkey,
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
          ephemeralSenderPubkey: alice.actor.stablePubkey,
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
    expect(coordinator.getActiveSubscriptionCount()).toBe(2);
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
    expect(coordinator.getActiveSubscriptionCount()).toBe(2);

    const otherMessage = await createApplicationMessageBytes({
      state: otherState,
      plaintext: "should not cross-talk",
    });
    adapter.postGroupMessage(
      { msg_64: encodeBase64(otherMessage.encodedMessage) },
      createExtra(alice.actor.stablePubkey),
    );

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writtenChunks).toHaveLength(0);

    const subscribedMessage = await createApplicationMessageBytes({
      state: subscribedState,
      plaintext: "subscribed live",
    });
    const subscribedPosted = adapter.postGroupMessage(
      { msg_64: encodeBase64(subscribedMessage.encodedMessage) },
      createExtra(alice.actor.stablePubkey),
    );

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
      subscribeManyGroupMessagesInputSchema.parse({ groups: [] }),
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
