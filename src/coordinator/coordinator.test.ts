import { describe, expect, test } from "vitest";
import { createGroup, unsafeTestingAuthenticationService } from "ts-mls";

import { Coordinator } from "./coordinator.ts";
import {
  createActor,
  createBytes,
  createKeyPackageRef,
  createMemberArtifacts,
  createPrivateMessage,
  createWelcomeForNewMember,
  getTestCiphersuite,
} from "./testUtils.ts";

describe("Coordinator key package flow", () => {
  test("publishes, lists, consumes, and snapshots key packages in FIFO order", async () => {
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
    });

    const secondRecord = coordinator.publishKeyPackage({
      stablePubkey,
      keyPackage: second.keyPackage,
      keyPackageRef: secondKeyPackageRef,
    });

    const listed = coordinator.listKeyPackagesForIdentity(stablePubkey);

    expect(listed).toHaveLength(2);
    expect(listed[0]?.keyPackageRef).toBe(firstRecord.keyPackageRef);
    expect(listed[1]?.keyPackageRef).toBe(secondRecord.keyPackageRef);
    expect(coordinator.snapshot()).toMatchObject({
      stableIdentities: 1,
      publishedKeyPackages: 2,
    });

    const consumedFirst = coordinator.consumeKeyPackage(stablePubkey);
    const consumedSecond = coordinator.consumeKeyPackage(stablePubkey);
    const consumedEmpty = coordinator.consumeKeyPackage(stablePubkey);

    expect(consumedFirst?.keyPackageRef).toBe(firstRecord.keyPackageRef);
    expect(consumedSecond?.keyPackageRef).toBe(secondRecord.keyPackageRef);
    expect(consumedEmpty).toBeNull();
    expect(coordinator.listKeyPackagesForIdentity(stablePubkey)).toEqual([]);
    expect(coordinator.snapshot()).toMatchObject({
      stableIdentities: 0,
      publishedKeyPackages: 0,
    });
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
    });

    coordinator.publishKeyPackage({
      stablePubkey,
      keyPackage: second.keyPackage,
      keyPackageRef: secondKeyPackageRef,
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
    });

    const bobRecord = coordinator.publishKeyPackage({
      stablePubkey: bob.actor.stablePubkey,
      keyPackage: bob.keyPackage,
      keyPackageRef: bobKeyPackageRef,
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
    });
    coordinator.publishKeyPackage({
      stablePubkey: actor.stablePubkey,
      keyPackage: lastResort.keyPackage,
      keyPackageRef: lastResortRef,
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
  test("stores and drains queued welcomes per target identity", async () => {
    const coordinator = new Coordinator();
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

    expect(coordinator.snapshot()).toMatchObject({
      pendingWelcomes: 2,
    });

    const fetchedBob = coordinator.fetchPendingWelcomes(bob.actor.stablePubkey);
    const fetchedCarol = coordinator.fetchPendingWelcomes(
      carol.actor.stablePubkey,
    );

    expect(fetchedBob).toHaveLength(1);
    expect(fetchedBob[0]?.keyPackageReference).toBe(
      firstFixture.keyPackageRefHex,
    );
    expect(fetchedCarol).toHaveLength(1);
    expect(fetchedCarol[0]?.keyPackageReference).toBe(
      secondFixture.keyPackageRefHex,
    );
    expect(coordinator.fetchPendingWelcomes(bob.actor.stablePubkey)).toEqual(
      [],
    );
    expect(coordinator.fetchPendingWelcomes(carol.actor.stablePubkey)).toEqual(
      [],
    );
    expect(coordinator.snapshot()).toMatchObject({
      pendingWelcomes: 0,
    });
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
    expect(coordinator.snapshot()).toMatchObject({
      trackedGroups: 1,
      queuedMessages: 2,
    });
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
});
