import { afterEach, describe, expect, test } from "vitest";
import { createGroup, unsafeTestingAuthenticationService } from "ts-mls";

import { Coordinator } from "../coordinator.ts";
import { InMemoryCoordinatorStorage } from "./inMemoryStorage.ts";
import { SqliteCoordinatorStorage } from "./sqliteStorage.ts";
import type { CoordinatorStorage } from "./storage.ts";
import {
  createActor,
  createBytes,
  createKeyPackageRef,
  createMemberArtifacts,
  createPrivateMessage,
  createWelcomeForNewMember,
  getTestCiphersuite,
} from "../testUtils.ts";

function createCoordinatorWithStorage(
  storage: CoordinatorStorage,
): Coordinator {
  let tick = 1_700_000_000_000;
  return new Coordinator({
    storage,
    now: () => {
      tick += 1;
      return tick;
    },
  });
}

const closers = new Set<() => void>();

interface StorageFixture {
  name: string;
  createStorage(): CoordinatorStorage;
}

afterEach(() => {
  for (const close of closers) {
    close();
  }
  closers.clear();
});

describe.each<StorageFixture>([
  {
    name: "in-memory",
    createStorage: () => new InMemoryCoordinatorStorage(),
  },
  {
    name: "sqlite",
    createStorage: () => new SqliteCoordinatorStorage({ path: ":memory:" }),
  },
])("Coordinator storage parity: $name", ({ createStorage }) => {
  test("publishes, lists, consumes, and snapshots key packages in FIFO order", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);
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

    expect(coordinator.listKeyPackagesForIdentity(stablePubkey)).toHaveLength(
      2,
    );
    expect(
      coordinator.listAllKeyPackages().map((record) => record.keyPackageRef),
    ).toEqual([firstRecord.keyPackageRef, secondRecord.keyPackageRef]);

    const consumedFirst = coordinator.consumeKeyPackage(stablePubkey);
    const consumedSecond = coordinator.consumeKeyPackage(secondKeyPackageRef);
    const consumedEmpty = coordinator.consumeKeyPackage(stablePubkey);

    expect(consumedFirst?.keyPackageRef).toBe(firstRecord.keyPackageRef);
    expect(consumedSecond?.keyPackageRef).toBe(secondRecord.keyPackageRef);
    expect(consumedEmpty).toBeNull();
    expect(coordinator.snapshot()).toMatchObject({
      stableIdentities: 0,
      publishedKeyPackages: 0,
    });
  });

  test("keeps last-resort key packages after consume and supports explicit remove", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);
    const actor = createActor("alice-last-resort-storage");
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
    expect(
      coordinator.consumeKeyPackage(actor.stablePubkey)?.keyPackageRef,
    ).toBe(lastResortRef);
    expect(coordinator.getKeyPackage(lastResortRef)?.isLastResort).toBe(true);
    expect(coordinator.removeKeyPackage(lastResortRef)?.keyPackageRef).toBe(
      lastResortRef,
    );
    expect(coordinator.getKeyPackage(lastResortRef)).toBeNull();
  });

  test("stores and drains queued welcomes per target identity", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);
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
    expect(fetchedCarol).toHaveLength(1);
    expect(coordinator.fetchPendingWelcomes(bob.actor.stablePubkey)).toEqual(
      [],
    );
    expect(coordinator.fetchPendingWelcomes(carol.actor.stablePubkey)).toEqual(
      [],
    );
    expect(coordinator.snapshot()).toMatchObject({ pendingWelcomes: 0 });
  });

  test("stores group messages, tracks routing, and rejects stale handshakes", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    const firstMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice-ephemeral-1",
      opaqueMessage: createPrivateMessage({
        epoch: 5n,
        contentType: 3,
        bytes: Array.from(createBytes([1, 2, 3])),
      }),
    });
    const secondMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "bob-ephemeral-1",
      opaqueMessage: createPrivateMessage({
        epoch: 5n,
        contentType: 1,
        bytes: [4, 5, 6],
      }),
    });

    expect(
      coordinator.fetchGroupMessages({ groupId: "group-local" }),
    ).toHaveLength(2);
    expect(
      coordinator.fetchGroupMessages({
        groupId: "group-local",
        afterCursor: firstMessage.cursor,
      }),
    ).toEqual([expect.objectContaining({ cursor: secondMessage.cursor })]);
    expect(coordinator.getGroupRouting("group-local")).toEqual({
      groupId: "group-local",
      latestHandshakeEpoch: 5n,
      lastMessageCursor: secondMessage.cursor,
    });
    expect(coordinator.snapshot()).toMatchObject({
      trackedGroups: 1,
      queuedMessages: 2,
    });

    expect(() =>
      coordinator.postGroupMessage({
        ephemeralSenderPubkey: "carol-ephemeral-1",
        opaqueMessage: createPrivateMessage({
          epoch: 4n,
          contentType: 2,
          bytes: [7, 8],
        }),
      }),
    ).toThrow("Rejected stale handshake message");
  });

  test("assigns monotonic cursors independently per group", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    const firstGroupFirstMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice-ephemeral-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 3,
        bytes: [1, 2, 3],
      }),
    });

    const secondGroupFirstMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "bob-ephemeral-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-beta",
        epoch: 1n,
        contentType: 3,
        bytes: [4, 5, 6],
      }),
    });

    const firstGroupSecondMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "carol-ephemeral-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 3,
        bytes: [7, 8, 9],
      }),
    });

    expect(firstGroupFirstMessage.cursor).toBe(1);
    expect(secondGroupFirstMessage.cursor).toBe(1);
    expect(firstGroupSecondMessage.cursor).toBe(2);

    expect(
      coordinator
        .fetchGroupMessages({ groupId: "group-alpha" })
        .map((message) => message.cursor),
    ).toEqual([1, 2]);
    expect(
      coordinator
        .fetchGroupMessages({ groupId: "group-beta" })
        .map((message) => message.cursor),
    ).toEqual([1]);
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

  test("treats afterCursor as group-scoped even when another group uses the same cursor values", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    const alphaFirst = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alpha-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "beta-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-beta",
        epoch: 1n,
        contentType: 1,
        bytes: [2],
      }),
    });
    const alphaSecond = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alpha-2",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [3],
      }),
    });

    expect(alphaFirst.cursor).toBe(1);
    expect(alphaSecond.cursor).toBe(2);
    expect(
      coordinator.fetchGroupMessages({
        groupId: "group-alpha",
        afterCursor: 1,
      }),
    ).toEqual([expect.objectContaining({ cursor: 2, groupId: "group-alpha" })]);
    expect(
      coordinator.fetchGroupMessages({
        groupId: "group-beta",
        afterCursor: 1,
      }),
    ).toEqual([]);
  });
});
