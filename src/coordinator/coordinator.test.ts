import { describe, expect, test } from "vitest";
import { createGroup, unsafeTestingAuthenticationService } from "ts-mls";

import { Coordinator } from "./coordinator.ts";
import {
  createActor,
  createBytes,
  createKeyPackageRef,
  createMemberArtifacts,
  createSignedPublicationEvent,
  createPrivateMessage,
  createWelcomeForNewMember,
  getTestCiphersuite,
} from "./testUtils.ts";

describe("Coordinator key package flow", () => {
  test("publishes, lists, consumes, in FIFO order", async () => {
    const coordinator = new Coordinator();
    const alice = await createMemberArtifacts(createActor("alice-unit"));
    const stablePubkey = alice.actor.stablePubkey;
    const firstKeyPackageRef = await createKeyPackageRef(alice.keyPackage);
    const second = await createMemberArtifacts(createActor("alice-unit-next"));
    const secondKeyPackageRef = await createKeyPackageRef(second.keyPackage);

    const firstRecord = coordinator.publishKeyPackage({
      stablePubkey,
      keyPackage: alice.keyPackage,
      keyPackageRef: firstKeyPackageRef,
      publicationEvent: createSignedPublicationEvent({
        actor: alice.actor,
        keyPackage: alice.keyPackage,
      }),
    });

    const secondRecord = coordinator.publishKeyPackage({
      stablePubkey,
      keyPackage: second.keyPackage,
      keyPackageRef: secondKeyPackageRef,
      publicationEvent: createSignedPublicationEvent({
        actor: second.actor,
        keyPackage: second.keyPackage,
      }),
    });

    const listed = coordinator.listKeyPackagesForIdentity(stablePubkey);

    expect(listed).toHaveLength(2);
    expect(listed[0]?.keyPackageRef).toBe(firstRecord.keyPackageRef);
    expect(listed[1]?.keyPackageRef).toBe(secondRecord.keyPackageRef);

    const consumedFirst = coordinator.consumeKeyPackage(stablePubkey);
    const consumedSecond = coordinator.consumeKeyPackage(stablePubkey);
    const consumedEmpty = coordinator.consumeKeyPackage(stablePubkey);

    expect(consumedFirst?.keyPackageRef).toBe(firstRecord.keyPackageRef);
    expect(consumedSecond?.keyPackageRef).toBe(secondRecord.keyPackageRef);
    expect(consumedEmpty).toBeNull();
    expect(coordinator.listKeyPackagesForIdentity(stablePubkey)).toEqual([]);
  });

  test("consumes an exact published key package by key package ref", async () => {
    const coordinator = new Coordinator();
    const alice = await createMemberArtifacts(createActor("alice-ref"));
    const stablePubkey = alice.actor.stablePubkey;
    const firstKeyPackageRef = await createKeyPackageRef(alice.keyPackage);
    const second = await createMemberArtifacts(createActor("alice-ref-next"));
    const secondKeyPackageRef = await createKeyPackageRef(second.keyPackage);

    coordinator.publishKeyPackage({
      stablePubkey,
      keyPackage: alice.keyPackage,
      keyPackageRef: firstKeyPackageRef,
      publicationEvent: createSignedPublicationEvent({
        actor: alice.actor,
        keyPackage: alice.keyPackage,
      }),
    });

    coordinator.publishKeyPackage({
      stablePubkey,
      keyPackage: second.keyPackage,
      keyPackageRef: secondKeyPackageRef,
      publicationEvent: createSignedPublicationEvent({
        actor: second.actor,
        keyPackage: second.keyPackage,
      }),
    });

    const consumed = coordinator.consumeKeyPackage(secondKeyPackageRef);

    expect(consumed?.keyPackageRef).toBe(secondKeyPackageRef);
    expect(
      coordinator
        .listKeyPackagesForIdentity(stablePubkey)
        .map((record) => record.keyPackageRef),
    ).toEqual([firstKeyPackageRef]);
  });

  test("lists all available key packages across identities", async () => {
    const coordinator = new Coordinator();
    const alice = await createMemberArtifacts(createActor("alice-global"));
    const bob = await createMemberArtifacts(createActor("bob-global"));
    const aliceKeyPackageRef = await createKeyPackageRef(alice.keyPackage);
    const bobKeyPackageRef = await createKeyPackageRef(bob.keyPackage);

    const aliceRecord = coordinator.publishKeyPackage({
      stablePubkey: alice.actor.stablePubkey,
      keyPackage: alice.keyPackage,
      keyPackageRef: aliceKeyPackageRef,
      publicationEvent: createSignedPublicationEvent({
        actor: alice.actor,
        keyPackage: alice.keyPackage,
      }),
    });

    const bobRecord = coordinator.publishKeyPackage({
      stablePubkey: bob.actor.stablePubkey,
      keyPackage: bob.keyPackage,
      keyPackageRef: bobKeyPackageRef,
      publicationEvent: createSignedPublicationEvent({
        actor: bob.actor,
        keyPackage: bob.keyPackage,
      }),
    });

    expect(
      coordinator.listAllKeyPackages().map((record) => record.keyPackageRef),
    ).toEqual([aliceRecord.keyPackageRef, bobRecord.keyPackageRef]);
  });

  test("keeps last-resort key packages available on consume and explicit lookup", async () => {
    const coordinator = new Coordinator();
    const actor = createActor("alice-last-resort");
    const regular = await createMemberArtifacts(actor);
    const lastResort = await createMemberArtifacts(actor, { lastResort: true });
    const regularRef = await createKeyPackageRef(regular.keyPackage);
    const lastResortRef = await createKeyPackageRef(lastResort.keyPackage);

    coordinator.publishKeyPackage({
      stablePubkey: actor.stablePubkey,
      keyPackage: regular.keyPackage,
      keyPackageRef: regularRef,
      publicationEvent: createSignedPublicationEvent({
        actor,
        keyPackage: regular.keyPackage,
      }),
    });
    coordinator.publishKeyPackage({
      stablePubkey: actor.stablePubkey,
      keyPackage: lastResort.keyPackage,
      keyPackageRef: lastResortRef,
      publicationEvent: createSignedPublicationEvent({
        actor,
        keyPackage: lastResort.keyPackage,
      }),
    });

    expect(
      coordinator.consumeKeyPackage(actor.stablePubkey)?.keyPackageRef,
    ).toBe(regularRef);

    const consumedLastResort = coordinator.consumeKeyPackage(
      actor.stablePubkey,
    );
    expect(consumedLastResort?.keyPackageRef).toBe(lastResortRef);
    expect(consumedLastResort?.isLastResort).toBe(true);
    expect(coordinator.consumeKeyPackage(lastResortRef)?.keyPackageRef).toBe(
      lastResortRef,
    );
    expect(
      coordinator
        .listKeyPackagesForIdentity(actor.stablePubkey)
        .map((record) => record.keyPackageRef),
    ).toEqual([lastResortRef]);
  });

  test("removes a published key package by ref", async () => {
    const coordinator = new Coordinator();
    const alice = await createMemberArtifacts(createActor("alice-remove"));
    const keyPackageRef = await createKeyPackageRef(alice.keyPackage);

    coordinator.publishKeyPackage({
      stablePubkey: alice.actor.stablePubkey,
      keyPackage: alice.keyPackage,
      keyPackageRef,
      publicationEvent: createSignedPublicationEvent({
        actor: alice.actor,
        keyPackage: alice.keyPackage,
      }),
    });

    expect(coordinator.getKeyPackage(keyPackageRef)?.keyPackageRef).toBe(
      keyPackageRef,
    );
    expect(coordinator.removeKeyPackage(keyPackageRef)?.keyPackageRef).toBe(
      keyPackageRef,
    );
    expect(coordinator.getKeyPackage(keyPackageRef)).toBeNull();
  });
});

describe("Coordinator welcome flow", () => {
  test("stores and returns queued welcomes per target identity without draining", async () => {
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const alice = await createMemberArtifacts(createActor("alice-unit"));
    const bob = await createMemberArtifacts(createActor("bob-unit"));
    const carol = await createMemberArtifacts(createActor("carol-unit"));
    const cipherSuite = await getTestCiphersuite();
    let aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("welcome-flow"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });
    const firstFixture = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bob,
    });
    aliceState = firstFixture.senderState;
    const secondFixture = await createWelcomeForNewMember({
      senderState: aliceState,
      member: carol,
    });

    coordinator.storeWelcome({
      targetStablePubkey: bob.actor.stablePubkey,
      keyPackageReference: firstFixture.keyPackageRefHex,
      welcome: firstFixture.welcome,
    });

    coordinator.storeWelcome({
      targetStablePubkey: carol.actor.stablePubkey,
      keyPackageReference: secondFixture.keyPackageRefHex,
      welcome: secondFixture.welcome,
    });

    const fetchedBob = coordinator.fetchPendingWelcomes(bob.actor.stablePubkey);
    const fetchedCarol = coordinator.fetchPendingWelcomes(
      carol.actor.stablePubkey,
    );

    expect(fetchedBob).toHaveLength(1);
    expect(fetchedBob[0]?.keyPackageReference).toBe(
      firstFixture.keyPackageRefHex,
    );
    expect(fetchedBob[0]?.readAt).not.toBeNull();
    expect(fetchedCarol).toHaveLength(1);
    expect(fetchedCarol[0]?.keyPackageReference).toBe(
      secondFixture.keyPackageRefHex,
    );
    expect(fetchedCarol[0]?.readAt).not.toBeNull();

    // Welcomes survive subsequent fetches (non-destructive).
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);
    expect(
      coordinator.fetchPendingWelcomes(carol.actor.stablePubkey),
    ).toHaveLength(1);
  });

  test("deletes expired welcomes via TTL cleanup", async () => {
    let tick = 1_700_000_000_000;
    const coordinator = new Coordinator({
      now: () => {
        tick += 1;
        return tick;
      },
      welcomeCleanupIntervalMs: 0,
    });
    const alice = await createMemberArtifacts(createActor("alice-unit"));
    const bob = await createMemberArtifacts(createActor("bob-unit"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("welcome-ttl"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });
    const fixture = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bob,
    });

    coordinator.storeWelcome({
      targetStablePubkey: bob.actor.stablePubkey,
      keyPackageReference: fixture.keyPackageRefHex,
      welcome: fixture.welcome,
    });

    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);

    // Advance time past the 1h default TTL and run cleanup.
    tick += 3_700_000; // ~1h 2min
    const deleted = coordinator.deleteExpiredWelcomes(tick - 3_600_000); // 1h TTL
    expect(deleted).toBe(1);
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(0);
  });

  test("does not delete unread welcomes regardless of age", async () => {
    let tick = 1_700_000_000_000;
    const coordinator = new Coordinator({
      now: () => {
        tick += 1;
        return tick;
      },
      welcomeCleanupIntervalMs: 0,
    });
    const alice = await createMemberArtifacts(createActor("alice-unit"));
    const bob = await createMemberArtifacts(createActor("bob-unit"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("welcome-unread"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    });
    const fixture = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bob,
    });

    coordinator.storeWelcome({
      targetStablePubkey: bob.actor.stablePubkey,
      keyPackageReference: fixture.keyPackageRefHex,
      welcome: fixture.welcome,
    });

    // Never fetch, so readAt remains null.

    // Advance time well past any reasonable TTL.
    tick += 90_000_000; // 25 hours
    const deleted = coordinator.deleteExpiredWelcomes(tick - 3_600_000);
    expect(deleted).toBe(0);

    // Unread welcome is still present.
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);
  });
});

describe("Coordinator group message flow", () => {
  test("stores message references and supports cursor-based fetches", () => {
    const coordinator = new Coordinator();

    const firstMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice-ephemeral-1",
      opaqueMessage: createPrivateMessage({
        epoch: 1n,
        contentType: 1,
        bytes: Array.from(createBytes([1, 2, 3])),
      }),
    });

    const secondMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "bob-ephemeral-1",
      opaqueMessage: createPrivateMessage({
        epoch: 1n,
        contentType: 1,
        bytes: [4, 5, 6],
      }),
    });

    expect(firstMessage.groupId).toBe("group-local");
    expect(secondMessage.groupId).toBe("group-local");

    const fetchedAll = coordinator.fetchGroupMessages({
      groupId: "group-local",
    });

    expect(fetchedAll).toHaveLength(2);
    expect(Array.from(fetchedAll[0]?.opaqueMessage ?? [])).toEqual(
      Array.from(
        createPrivateMessage({ epoch: 1n, contentType: 1, bytes: [1, 2, 3] }),
      ),
    );
    expect(Array.from(fetchedAll[1]?.opaqueMessage ?? [])).toEqual(
      Array.from(
        createPrivateMessage({ epoch: 1n, contentType: 1, bytes: [4, 5, 6] }),
      ),
    );
    const fetchedAfterCursor = coordinator.fetchGroupMessages({
      groupId: "group-local",
      afterCursor: firstMessage.cursor,
    });

    expect(fetchedAfterCursor).toHaveLength(1);
    expect(fetchedAfterCursor[0]?.cursor).toBe(secondMessage.cursor);
  });

  test("tracks handshake epochs and rejects stale handshake traffic", () => {
    const coordinator = new Coordinator();

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice-ephemeral-2",
      opaqueMessage: createPrivateMessage({
        epoch: 5n,
        contentType: 3,
        bytes: [10, 11],
      }),
    });

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "bob-ephemeral-2",
      opaqueMessage: createPrivateMessage({
        epoch: 5n,
        contentType: 1,
        bytes: [12, 13],
      }),
    });

    expect(coordinator.getGroupRouting("group-local")).toEqual({
      groupId: "group-local",
      latestHandshakeEpoch: 5n,
      lastMessageCursor: 2,
    });

    expect(() =>
      coordinator.postGroupMessage({
        ephemeralSenderPubkey: "carol-ephemeral-2",
        opaqueMessage: createPrivateMessage({
          epoch: 4n,
          contentType: 2,
          bytes: [14, 15],
        }),
      }),
    ).toThrow("Rejected stale handshake message");

    expect(coordinator.getGroupRouting("unknown-group")).toBeNull();
  });

  test("keeps cursors monotonic per group across multiple groups", () => {
    const coordinator = new Coordinator();

    const alphaFirst = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice-alpha-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1, 2],
      }),
    });
    const betaFirst = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "bob-beta-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-beta",
        epoch: 1n,
        contentType: 1,
        bytes: [3, 4],
      }),
    });
    const alphaSecond = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "carol-alpha-2",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [5, 6],
      }),
    });

    expect(alphaFirst.cursor).toBe(1);
    expect(betaFirst.cursor).toBe(1);
    expect(alphaSecond.cursor).toBe(2);
    expect(
      coordinator.fetchGroupMessages({
        groupId: "group-alpha",
        afterCursor: 1,
      }),
    ).toEqual([expect.objectContaining({ cursor: 2, groupId: "group-alpha" })]);
    expect(
      coordinator.fetchGroupMessages({ groupId: "group-beta", afterCursor: 1 }),
    ).toEqual([]);
    expect(coordinator.getGroupRouting("group-alpha")).toEqual({
      groupId: "group-alpha",
      latestHandshakeEpoch: 1n,
      lastMessageCursor: 2,
    });
    expect(coordinator.getGroupRouting("group-beta")).toEqual({
      groupId: "group-beta",
      latestHandshakeEpoch: 1n,
      lastMessageCursor: 1,
    });
  });

  test("replays backlog and streams new live group messages in order", async () => {
    const coordinator = new Coordinator();

    const firstMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice-live-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-live",
        epoch: 1n,
        contentType: 1,
        bytes: [1, 2, 3],
      }),
    });

    const subscription = coordinator.subscribeGroupMessages({
      groupId: "group-live",
      afterCursor: 0,
    });

    const iterator = subscription.messages[Symbol.asyncIterator]();

    const secondMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "bob-live-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-live",
        epoch: 1n,
        contentType: 1,
        bytes: [4, 5, 6],
      }),
    });

    const liveResult = await iterator.next();

    expect(liveResult.done).toBe(false);
    expect(liveResult.value).toMatchObject({
      cursor: secondMessage.cursor,
      groupId: "group-live",
    });

    expect(
      coordinator.fetchGroupMessages({
        groupId: "group-live",
        afterCursor: firstMessage.cursor,
      }),
    ).toEqual([secondMessage]);

    subscription.unsubscribe();
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  test("multi-group subscription replays backlog and streams live messages through one iterator", async () => {
    const coordinator = new Coordinator();

    const alphaBacklog = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alpha-live-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    const betaSkipped = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "beta-live-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-beta",
        epoch: 1n,
        contentType: 1,
        bytes: [2],
      }),
    });
    const betaBacklog = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "beta-live-2",
      opaqueMessage: createPrivateMessage({
        groupId: "group-beta",
        epoch: 1n,
        contentType: 1,
        bytes: [3],
      }),
    });

    const subscription = coordinator.subscribeManyGroupMessages({
      groups: [
        { groupId: "group-alpha", afterCursor: 0 },
        { groupId: "group-beta", afterCursor: betaSkipped.cursor },
      ],
    });
    const iterator = subscription.messages[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { groupId: "group-alpha", cursor: alphaBacklog.cursor },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { groupId: "group-beta", cursor: betaBacklog.cursor },
    });

    const alphaLive = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alpha-live-2",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [4],
      }),
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { groupId: "group-alpha", cursor: alphaLive.cursor },
    });
    expect(coordinator.getActiveSubscriptionCount()).toBe(2);

    subscription.unsubscribe();
    expect(coordinator.getActiveSubscriptionCount()).toBe(0);
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  test("multi-group subscription deduplicates repeated group registrations during cleanup", async () => {
    const coordinator = new Coordinator();

    const subscription = coordinator.subscribeManyGroupMessages({
      groups: [
        { groupId: "group-dup", afterCursor: 0 },
        { groupId: "group-dup", afterCursor: 0 },
      ],
    });

    expect(coordinator.getActiveSubscriptionCount()).toBe(1);

    subscription.unsubscribe();

    expect(coordinator.getActiveSubscriptionCount()).toBe(0);
  });
});
