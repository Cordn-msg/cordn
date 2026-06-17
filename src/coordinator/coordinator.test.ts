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
    const deleted = coordinator.deleteExpiredWelcomes(tick - 3_600_000, 0); // 1h TTL, unread preserved
    expect(deleted).toBe(1);
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(0);
  });

  test("does not delete unread welcomes regardless of age when maxAgeMs is disabled (0)", async () => {
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
    const deleted = coordinator.deleteExpiredWelcomes(tick - 3_600_000, 0);
    expect(deleted).toBe(0);

    // Unread welcome is still present.
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);
  });

  test("deletes unread welcomes older than welcomeMaxAgeMs", async () => {
    let tick = 1_700_000_000_000;
    const maxAgeMs = 3_600_000; // 1h max age for unread
    const coordinator = new Coordinator({
      now: () => {
        tick += 1;
        return tick;
      },
      welcomeCleanupIntervalMs: 0,
      welcomeMaxAgeMs: maxAgeMs,
    });
    const alice = await createMemberArtifacts(createActor("alice-unit"));
    const bob = await createMemberArtifacts(createActor("bob-unit"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("welcome-unread-maxage"),
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
    // Advance time past the unread maxAge threshold.
    tick += maxAgeMs + 60_000; // 1h 1min
    const readThreshold = tick - 3_600_000; // 1h read TTL
    const unreadThreshold = tick - maxAgeMs;
    const deleted = coordinator.deleteExpiredWelcomes(
      readThreshold,
      unreadThreshold,
    );
    expect(deleted).toBe(1);

    // Unread welcome too old — deleted.
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(0);
  });

  test("keeps unread welcomes younger than welcomeMaxAgeMs", async () => {
    let tick = 1_700_000_000_000;
    const maxAgeMs = 3_600_000; // 1h max age for unread
    const coordinator = new Coordinator({
      now: () => {
        tick += 1;
        return tick;
      },
      welcomeCleanupIntervalMs: 0,
      welcomeMaxAgeMs: maxAgeMs,
    });
    const alice = await createMemberArtifacts(createActor("alice-unit"));
    const bob = await createMemberArtifacts(createActor("bob-unit"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("welcome-unread-keep"),
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
    // Advance time to just before the unread maxAge threshold.
    tick += maxAgeMs - 60_000; // 59min — still within maxAge
    const readThreshold = tick - 3_600_000;
    const unreadThreshold = tick - maxAgeMs;
    const deleted = coordinator.deleteExpiredWelcomes(
      readThreshold,
      unreadThreshold,
    );
    expect(deleted).toBe(0);

    // Unread welcome is young enough — still present.
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);
  });

  test("round-trips joinAfterCursor so invitees can skip pre-join messages", async () => {
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const alice = await createMemberArtifacts(createActor("alice-unit"));
    const bob = await createMemberArtifacts(createActor("bob-unit"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("welcome-join-after"),
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
      joinAfterCursor: 42,
    });

    const fetched = coordinator.fetchPendingWelcomes(bob.actor.stablePubkey);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.joinAfterCursor).toBe(42);

    // Welcomes without joinAfterCursor return undefined (backward compat).
    coordinator.storeWelcome({
      targetStablePubkey: bob.actor.stablePubkey,
      keyPackageReference: "no-cursor-ref",
      welcome: fixture.welcome,
    });
    const secondFetch = coordinator.fetchPendingWelcomes(
      bob.actor.stablePubkey,
    );
    const withoutCursor = secondFetch.find(
      (w) => w.keyPackageReference === "no-cursor-ref",
    );
    expect(withoutCursor?.joinAfterCursor).toBeUndefined();
  });
});

describe("Coordinator join request flow", () => {
  test("stores and returns pending join requests per group without draining", () => {
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "member-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "member-2",
      opaqueMessage: createPrivateMessage({
        groupId: "group-beta",
        epoch: 1n,
        contentType: 1,
        bytes: [2],
      }),
    });

    coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });

    coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "bob-requester",
      keyPackageRef: "kp-ref-bob-1",
    });

    coordinator.storeJoinRequest({
      groupId: "group-beta",
      requesterStablePubkey: "carol-requester",
      keyPackageRef: "kp-ref-carol-1",
    });

    const fetchedAlpha = coordinator.fetchPendingJoinRequests("group-alpha");
    const fetchedBeta = coordinator.fetchPendingJoinRequests("group-beta");

    expect(fetchedAlpha).toHaveLength(2);
    expect(fetchedAlpha[0]?.requesterStablePubkey).toBe("alice-requester");
    expect(fetchedAlpha[0]?.keyPackageRef).toBe("kp-ref-alice-1");
    expect(fetchedAlpha[0]?.readAt).not.toBeNull();
    expect(fetchedAlpha[1]?.requesterStablePubkey).toBe("bob-requester");
    expect(fetchedAlpha[1]?.keyPackageRef).toBe("kp-ref-bob-1");
    expect(fetchedAlpha[1]?.readAt).not.toBeNull();

    expect(fetchedBeta).toHaveLength(1);
    expect(fetchedBeta[0]?.requesterStablePubkey).toBe("carol-requester");
    expect(fetchedBeta[0]?.keyPackageRef).toBe("kp-ref-carol-1");
    expect(fetchedBeta[0]?.readAt).not.toBeNull();

    // Requests survive subsequent fetches (non-destructive).
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(2);
    expect(coordinator.fetchPendingJoinRequests("group-beta")).toHaveLength(1);
  });

  test("deletes expired join requests via TTL cleanup", () => {
    let tick = 1_700_000_000_000;
    const coordinator = new Coordinator({
      now: () => {
        tick += 1;
        return tick;
      },
      welcomeCleanupIntervalMs: 0,
    });

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "member-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });

    coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });

    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);

    // Advance time past the 1h default TTL and run cleanup.
    tick += 3_700_000; // ~1h 2min
    const deleted = coordinator.deleteExpiredJoinRequests(tick - 3_600_000, 0); // 1h TTL, unread preserved
    expect(deleted).toBe(1);
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(0);
  });

  test("does not delete unread join requests regardless of age when maxAgeMs is disabled (0)", () => {
    let tick = 1_700_000_000_000;
    const coordinator = new Coordinator({
      now: () => {
        tick += 1;
        return tick;
      },
      welcomeCleanupIntervalMs: 0,
    });

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "member-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });

    coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });

    // Never fetch, so readAt remains null.

    // Advance time well past any reasonable TTL.
    tick += 90_000_000; // 25 hours
    const deleted = coordinator.deleteExpiredJoinRequests(tick - 3_600_000, 0);
    expect(deleted).toBe(0);

    // Unread request is still present.
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);
  });

  test("deletes unread join requests older than welcomeMaxAgeMs", () => {
    let tick = 1_700_000_000_000;
    const maxAgeMs = 3_600_000; // 1h max age for unread
    const coordinator = new Coordinator({
      now: () => {
        tick += 1;
        return tick;
      },
      welcomeCleanupIntervalMs: 0,
      welcomeMaxAgeMs: maxAgeMs,
    });

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "member-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });

    coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });

    // Never fetch, so readAt remains null.
    // Advance time past the unread maxAge threshold.
    tick += maxAgeMs + 60_000; // 1h 1min
    const readThreshold = tick - 3_600_000; // 1h read TTL
    const unreadThreshold = tick - maxAgeMs;
    const deleted = coordinator.deleteExpiredJoinRequests(
      readThreshold,
      unreadThreshold,
    );
    expect(deleted).toBe(1);

    // Unread request too old — deleted.
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(0);
  });

  test("keeps unread join requests younger than welcomeMaxAgeMs", () => {
    let tick = 1_700_000_000_000;
    const maxAgeMs = 3_600_000; // 1h max age for unread
    const coordinator = new Coordinator({
      now: () => {
        tick += 1;
        return tick;
      },
      welcomeCleanupIntervalMs: 0,
      welcomeMaxAgeMs: maxAgeMs,
    });

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "member-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });

    coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });

    // Never fetch, so readAt remains null.
    // Advance time to just before the unread maxAge threshold.
    tick += maxAgeMs - 60_000; // 59min — still within maxAge
    const readThreshold = tick - 3_600_000;
    const unreadThreshold = tick - maxAgeMs;
    const deleted = coordinator.deleteExpiredJoinRequests(
      readThreshold,
      unreadThreshold,
    );
    expect(deleted).toBe(0);

    // Unread request is young enough — still present.
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);
  });

  test("fetches many pending join requests across groups in a single call with non-destructive read-tracking", () => {
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "member-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "member-2",
      opaqueMessage: createPrivateMessage({
        groupId: "group-beta",
        epoch: 1n,
        contentType: 1,
        bytes: [2],
      }),
    });

    coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });
    coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "bob-requester",
      keyPackageRef: "kp-ref-bob-1",
    });
    coordinator.storeJoinRequest({
      groupId: "group-beta",
      requesterStablePubkey: "carol-requester",
      keyPackageRef: "kp-ref-carol-1",
    });

    const results = coordinator.fetchManyPendingJoinRequests({
      groups: [{ groupId: "group-alpha" }, { groupId: "group-beta" }],
    });

    // Ordered by input group order: alpha first, then beta.
    expect(results).toHaveLength(3);
    expect(results[0]?.groupId).toBe("group-alpha");
    expect(results[0]?.requesterStablePubkey).toBe("alice-requester");
    expect(results[0]?.keyPackageRef).toBe("kp-ref-alice-1");
    expect(results[0]?.readAt).not.toBeNull();
    expect(results[1]?.groupId).toBe("group-alpha");
    expect(results[1]?.requesterStablePubkey).toBe("bob-requester");
    expect(results[1]?.keyPackageRef).toBe("kp-ref-bob-1");
    expect(results[1]?.readAt).not.toBeNull();
    expect(results[2]?.groupId).toBe("group-beta");
    expect(results[2]?.requesterStablePubkey).toBe("carol-requester");
    expect(results[2]?.keyPackageRef).toBe("kp-ref-carol-1");
    expect(results[2]?.readAt).not.toBeNull();

    // Requests survive subsequent fetches (non-destructive).
    const refetch = coordinator.fetchManyPendingJoinRequests({
      groups: [{ groupId: "group-alpha" }, { groupId: "group-beta" }],
    });
    expect(refetch).toHaveLength(3);
    // Already-read requests keep their original readAt.
    expect(refetch[0]?.readAt).toBe(results[0]?.readAt);
    expect(refetch[1]?.readAt).toBe(results[1]?.readAt);
    expect(refetch[2]?.readAt).toBe(results[2]?.readAt);
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

  test("subscribeGroupMessages accepts sinceEpoch and fetchGroupMessages respects it", () => {
    const coordinator = new Coordinator();

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice",
      opaqueMessage: createPrivateMessage({
        groupId: "group-sub-coord",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    const epoch3 = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice",
      opaqueMessage: createPrivateMessage({
        groupId: "group-sub-coord",
        epoch: 3n,
        contentType: 1,
        bytes: [2],
      }),
    });

    // The coordinator accepts sinceEpoch on subscribe (adapter fetches
    // backlog separately); verify fetchGroupMessages filters correctly.
    const subscription = coordinator.subscribeGroupMessages({
      groupId: "group-sub-coord",
      afterCursor: 0,
      sinceEpoch: 3n,
    });

    const backlog = coordinator.fetchGroupMessages({
      groupId: "group-sub-coord",
      afterCursor: 0,
      sinceEpoch: 3n,
    });

    expect(backlog).toHaveLength(1);
    expect(backlog[0]?.cursor).toBe(epoch3.cursor);

    subscription.unsubscribe();
  });

  test("subscribeManyGroupMessages passes per-group sinceEpoch through to fetchManyGroupMessages", async () => {
    const coordinator = new Coordinator();

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice",
      opaqueMessage: createPrivateMessage({
        groupId: "group-a-many-coord",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    const aEpoch3 = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice",
      opaqueMessage: createPrivateMessage({
        groupId: "group-a-many-coord",
        epoch: 3n,
        contentType: 1,
        bytes: [2],
      }),
    });
    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice",
      opaqueMessage: createPrivateMessage({
        groupId: "group-b-many-coord",
        epoch: 2n,
        contentType: 1,
        bytes: [3],
      }),
    });
    const bEpoch4 = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice",
      opaqueMessage: createPrivateMessage({
        groupId: "group-b-many-coord",
        epoch: 4n,
        contentType: 1,
        bytes: [4],
      }),
    });

    const subscription = coordinator.subscribeManyGroupMessages({
      groups: [
        { groupId: "group-a-many-coord", afterCursor: 0, sinceEpoch: 3n },
        { groupId: "group-b-many-coord", afterCursor: 0, sinceEpoch: 4n },
      ],
    });

    const iterator = subscription.messages[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { groupId: "group-a-many-coord", cursor: aEpoch3.cursor },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { groupId: "group-b-many-coord", cursor: bEpoch4.cursor },
    });

    subscription.unsubscribe();
    expect(coordinator.getActiveSubscriptionCount()).toBe(0);
  });

  test("routes encrypted messages by caller-supplied gid and skips MLS decoding", () => {
    const coordinator = new Coordinator();

    // Encrypted path: arbitrary opaque bytes, coordinator never decodes them.
    const encryptedBytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);

    const posted = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice-ephemeral",
      opaqueMessage: encryptedBytes,
      groupId: "delivery-topic-encrypted",
    });

    expect(posted.groupId).toBe("delivery-topic-encrypted");
    expect(posted.ephemeralSenderPubkey).toBe("alice-ephemeral");
    expect(posted.cursor).toBe(1);
    expect(posted.encrypted).toBe(true);
    expect(posted.epoch).toBe(0n);
    expect(posted.opaqueMessage).toEqual(encryptedBytes);

    // Fetched messages preserve the encrypted flag.
    const fetched = coordinator.fetchGroupMessages({
      groupId: "delivery-topic-encrypted",
    });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.encrypted).toBe(true);
    expect(fetched[0]?.epoch).toBe(0n);
    expect(fetched[0]?.groupId).toBe("delivery-topic-encrypted");

    // Messages from different delivery topics are isolated.
    const otherEncrypted = Uint8Array.from([0xca, 0xfe]);
    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "bob-ephemeral",
      opaqueMessage: otherEncrypted,
      groupId: "other-topic",
    });
    expect(
      coordinator.fetchGroupMessages({ groupId: "delivery-topic-encrypted" }),
    ).toHaveLength(1);
    expect(
      coordinator.fetchGroupMessages({ groupId: "other-topic" }),
    ).toHaveLength(1);
  });

  test("streams live encrypted messages through subscriptions", async () => {
    const coordinator = new Coordinator();

    const subscription = coordinator.subscribeGroupMessages({
      groupId: "encrypted-live",
      afterCursor: 0,
    });
    const iterator = subscription.messages[Symbol.asyncIterator]();

    const liveBytes = Uint8Array.from([0x11, 0x22, 0x33]);
    const posted = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "live-sender",
      opaqueMessage: liveBytes,
      groupId: "encrypted-live",
    });

    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      cursor: posted.cursor,
      groupId: "encrypted-live",
      encrypted: true,
      epoch: 0n,
    });

    subscription.unsubscribe();
  });
});
