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
  createSignedPublicationEvent,
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

function asSqliteInternals(storage: SqliteCoordinatorStorage): {
  database: {
    pragma: (sql: string, options?: { simple: boolean }) => unknown;
    prepare: (sql: string) => {
      all: () => Array<{ name: string }>;
    };
  };
} {
  return storage as unknown as {
    database: {
      pragma: (sql: string, options?: { simple: boolean }) => unknown;
      prepare: (sql: string) => {
        all: () => Array<{ name: string }>;
      };
    };
  };
}

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
  test("sqlite applies production pragmas and key package consume index", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());

    if (!(storage instanceof SqliteCoordinatorStorage)) {
      return;
    }

    const internals = asSqliteInternals(storage);
    const busyTimeout = internals.database.pragma("busy_timeout", {
      simple: true,
    });
    const indexes = internals.database
      .prepare("PRAGMA index_list('key_packages')")
      .all();

    expect(busyTimeout).toBe(5000);
    expect(indexes.map((index) => index.name)).toContain(
      "idx_key_packages_identity_last_resort_order",
    );
  });
  test("publishes, lists, consumes, in FIFO order", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);
    const alice = await createMemberArtifacts(createActor("alice-unit"));
    const stablePubkey = alice.actor.stablePubkey;
    const firstKeyPackageRef = await createKeyPackageRef(alice.keyPackage);
    const second = await createMemberArtifacts(createActor("alice-unit-next"));
    const secondKeyPackageRef = await createKeyPackageRef(second.keyPackage);
    const firstPublicationEvent = createSignedPublicationEvent({
      actor: alice.actor,
      keyPackage: alice.keyPackage,
    });
    const secondPublicationEvent = createSignedPublicationEvent({
      actor: second.actor,
      keyPackage: second.keyPackage,
    });

    const firstRecord = coordinator.publishKeyPackage({
      stablePubkey,
      keyPackage: alice.keyPackage,
      keyPackageRef: firstKeyPackageRef,
      publicationEvent: firstPublicationEvent,
    });

    const secondRecord = coordinator.publishKeyPackage({
      stablePubkey,
      keyPackage: second.keyPackage,
      keyPackageRef: secondKeyPackageRef,
      publicationEvent: secondPublicationEvent,
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
    expect(
      coordinator.consumeKeyPackage(actor.stablePubkey)?.keyPackageRef,
    ).toBe(lastResortRef);
    expect(coordinator.getKeyPackage(lastResortRef)?.isLastResort).toBe(true);
    expect(coordinator.removeKeyPackage(lastResortRef)?.keyPackageRef).toBe(
      lastResortRef,
    );
    expect(coordinator.getKeyPackage(lastResortRef)).toBeNull();
  });

  test("stores and returns queued welcomes per target identity without draining", async () => {
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

  test("deletes read welcomes that exceed TTL", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const coordinator = new Coordinator({
      storage,
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

    // Fetch marks the welcome as read.
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);

    // Advance time past the 1h default TTL.
    tick += 3_700_000; // ~1h 2min
    const deleted = coordinator.deleteExpiredWelcomes(tick - 3_600_000); // 1h TTL
    expect(deleted).toBe(1);

    // Welcome is gone after cleanup.
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(0);
  });

  test("does not delete unread welcomes regardless of age", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const coordinator = new Coordinator({
      storage,
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
      groupId: new TextEncoder().encode("welcome-ttl-2"),
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

  test("deleteExpiredWelcomes uses readAt timestamp, not createdAt", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const coordinator = new Coordinator({
      storage,
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
      groupId: new TextEncoder().encode("welcome-ttl-3"),
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

    // Advance time 2 hours before fetching (welcome is 2h old by createdAt).
    tick += 7_200_000; // 2 hours

    // Now fetch — this sets readAt to now (2h after createdAt).
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);

    // Advance only 30min past readAt — welcome is 2.5h old by createdAt
    // but only 30min old by readAt. A 1h TTL threshold should NOT delete it.
    tick += 1_800_000; // 30 minutes
    const deleted = coordinator.deleteExpiredWelcomes(tick - 3_600_000); // 1h TTL
    expect(deleted).toBe(0);

    // Welcome is still present.
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);
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

  test("fetches many group messages with independent cursors in input group order", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alpha-1",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    const betaFirst = coordinator.postGroupMessage({
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
    const betaSecond = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "beta-2",
      opaqueMessage: createPrivateMessage({
        groupId: "group-beta",
        epoch: 1n,
        contentType: 1,
        bytes: [4],
      }),
    });

    expect(
      coordinator
        .fetchManyGroupMessages({
          groups: [
            { groupId: "group-beta", afterCursor: betaFirst.cursor },
            { groupId: "group-alpha", afterCursor: 1 },
          ],
        })
        .map((message) => [message.groupId, message.cursor]),
    ).toEqual([
      ["group-beta", betaSecond.cursor],
      ["group-alpha", alphaSecond.cursor],
    ]);
  });
});
