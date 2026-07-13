import { afterEach, describe, expect, test } from "vitest";
import { createGroup, unsafeTestingAuthenticationService } from "ts-mls";

import { Coordinator } from "../coordinator.ts";
import { InMemoryCoordinatorStorage } from "./inMemoryStorage.ts";
import { SqliteCoordinatorStorage } from "./sqliteStorage.ts";
import {
  type CoordinatorStorage,
  MAX_PENDING_JOIN_REQUESTS_PER_GROUP,
} from "./storage.ts";
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
    expect(fetchedCarol).toHaveLength(1);
    expect(fetchedCarol[0]?.keyPackageReference).toBe(
      secondFixture.keyPackageRefHex,
    );

    // Welcomes survive subsequent fetches (non-destructive).
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);
    expect(
      coordinator.fetchPendingWelcomes(carol.actor.stablePubkey),
    ).toHaveLength(1);
  });

  test("round-trips welcome joinAfterCursor and defaults to undefined when absent", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);
    const alice = await createMemberArtifacts(createActor("alice-unit"));
    const bob = await createMemberArtifacts(createActor("bob-unit"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("welcome-after"),
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

    const withCursor = coordinator.fetchPendingWelcomes(bob.actor.stablePubkey);
    expect(withCursor).toHaveLength(1);
    expect(withCursor[0]?.joinAfterCursor).toBe(42);

    // Old-style welcome without a cursor hint stays undefined (back-compat).
    coordinator.storeWelcome({
      targetStablePubkey: bob.actor.stablePubkey,
      keyPackageReference: "no-cursor-ref",
      welcome: fixture.welcome,
    });
    const withoutCursor = coordinator.fetchPendingWelcomes(
      bob.actor.stablePubkey,
    );
    expect(
      withoutCursor.find((w) => w.keyPackageReference === "no-cursor-ref")
        ?.joinAfterCursor,
    ).toBeUndefined();
  });

  test("observation never deletes welcomes; maxAge is the only cleanup clock", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const maxAgeMs = 7_200_000; // 2h ceiling
    const coordinator = new Coordinator({
      storage,
      now: () => {
        tick += 1;
        return tick;
      },
      cleanupIntervalMs: 0,
      maxAgeMs: maxAgeMs,
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

    // Observe — this used to start a short read-TTL deletion timer.
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);

    // Advance past the old 1h read-TTL window but stay within maxAge. Survives.
    tick += 3_700_000; // ~1h 2min
    expect(coordinator.deleteExpiredWelcomes(tick - maxAgeMs)).toBe(0);
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);

    // Crossing the maxAge ceiling removes it.
    tick += maxAgeMs;
    expect(coordinator.deleteExpiredWelcomes(tick - maxAgeMs)).toBe(1);
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(0);
  });

  test("consumed ack retires a welcome atomically on fetch", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);
    const alice = await createMemberArtifacts(createActor("alice-unit"));
    const bob = await createMemberArtifacts(createActor("bob-unit"));
    const cipherSuite = await getTestCiphersuite();
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("welcome-consume"),
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

    const observed = coordinator.fetchPendingWelcomes(
      bob.actor.stablePubkey,
    )[0]!;

    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey, [
        {
          keyPackageReference: observed.keyPackageReference,
          createdAt: observed.createdAt,
        },
      ]),
    ).toHaveLength(0);
  });

  test("does not delete welcomes regardless of age", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const coordinator = new Coordinator({
      storage,
      now: () => {
        tick += 1;
        return tick;
      },
      cleanupIntervalMs: 0,
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

    // Never fetched; only the maxAge ceiling can reap it.

    // Advance time well past any reasonable TTL.
    tick += 90_000_000; // 25 hours
    const deleted = coordinator.deleteExpiredWelcomes(0);
    expect(deleted).toBe(0);

    // Unread welcome is still present.
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);
  });

  test("deletes welcomes older than maxAgeMs", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const maxAgeMs = 3_600_000; // 1h max age for
    const coordinator = new Coordinator({
      storage,
      now: () => {
        tick += 1;
        return tick;
      },
      cleanupIntervalMs: 0,
      maxAgeMs: maxAgeMs,
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

    // Never fetch.
    tick += maxAgeMs + 60_000; // past maxAge
    const deleted = coordinator.deleteExpiredWelcomes(tick - maxAgeMs);
    expect(deleted).toBe(1);
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(0);
  });

  test("keeps welcomes younger than maxAgeMs", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const maxAgeMs = 3_600_000;
    const coordinator = new Coordinator({
      storage,
      now: () => {
        tick += 1;
        return tick;
      },
      cleanupIntervalMs: 0,
      maxAgeMs: maxAgeMs,
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

    // Never fetch.
    tick += maxAgeMs - 60_000; // within maxAge
    const deleted = coordinator.deleteExpiredWelcomes(tick - maxAgeMs);
    expect(deleted).toBe(0);
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);
  });

  test("deleteExpiredWelcomes reaps by createdAt regardless of fetch", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const maxAgeMs = 7_200_000; // 2h ceiling
    const coordinator = new Coordinator({
      storage,
      now: () => {
        tick += 1;
        return tick;
      },
      cleanupIntervalMs: 0,
      maxAgeMs: maxAgeMs,
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

    // Advance 2h then fetch (observation must not reset the clock).
    tick += 7_200_000; // 2 hours
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);

    // Advance another 30min. createdAt is ~2.5h old — past the 2h maxAge — so
    // it is deleted. Observation grants no immunity from the createdAt ceiling.
    tick += 1_800_000; // 30 minutes
    const deleted = coordinator.deleteExpiredWelcomes(tick - maxAgeMs);
    expect(deleted).toBe(1);

    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(0);
  });

  test("stores group messages and tracks per-group routing", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    const firstMessage = coordinator.postGroupMessage({
      groupId: "group-local",
      opaqueMessage: createPrivateMessage({
        epoch: 5n,
        contentType: 3,
        bytes: Array.from(createBytes([1, 2, 3])),
      }),
    });

    const secondMessage = coordinator.postGroupMessage({
      groupId: "group-local",
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
    expect(coordinator.getGroupRouting("group-local")).toEqual(
      expect.objectContaining({
        groupId: "group-local",
        lastMessageCursor: secondMessage.cursor,
      }),
    );
  });

  test("stores opaque group messages without decoding", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    // Arbitrary opaque bytes — the coordinator must never decode these.
    const encryptedBytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);

    const posted = coordinator.postGroupMessage({
      opaqueMessage: encryptedBytes,
      groupId: "encrypted-topic",
    });

    expect(posted).toEqual(
      expect.objectContaining({
        groupId: "encrypted-topic",
        opaqueMessage: encryptedBytes,
        cursor: 1,
      }),
    );

    const fetched = coordinator.fetchGroupMessages({
      groupId: "encrypted-topic",
    });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toEqual(
      expect.objectContaining({
        groupId: "encrypted-topic",
        opaqueMessage: encryptedBytes,
      }),
    );
  });

  test("assigns monotonic cursors independently per group", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    const firstGroupFirstMessage = coordinator.postGroupMessage({
      groupId: "group-alpha",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 3,
        bytes: [1, 2, 3],
      }),
    });

    const secondGroupFirstMessage = coordinator.postGroupMessage({
      groupId: "group-beta",
      opaqueMessage: createPrivateMessage({
        groupId: "group-beta",
        epoch: 1n,
        contentType: 3,
        bytes: [4, 5, 6],
      }),
    });

    const firstGroupSecondMessage = coordinator.postGroupMessage({
      groupId: "group-alpha",
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
    expect(coordinator.getGroupRouting("group-alpha")).toEqual(
      expect.objectContaining({
        groupId: "group-alpha",
        lastMessageCursor: 2,
      }),
    );
    expect(coordinator.getGroupRouting("group-beta")).toEqual(
      expect.objectContaining({
        groupId: "group-beta",
        lastMessageCursor: 1,
      }),
    );
  });

  test("treats afterCursor as group-scoped even when another group uses the same cursor values", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    const alphaFirst = coordinator.postGroupMessage({
      groupId: "group-alpha",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    coordinator.postGroupMessage({
      groupId: "group-beta",
      opaqueMessage: createPrivateMessage({
        groupId: "group-beta",
        epoch: 1n,
        contentType: 1,
        bytes: [2],
      }),
    });
    const alphaSecond = coordinator.postGroupMessage({
      groupId: "group-alpha",
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
      groupId: "group-alpha",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    const betaFirst = coordinator.postGroupMessage({
      groupId: "group-beta",
      opaqueMessage: createPrivateMessage({
        groupId: "group-beta",
        epoch: 1n,
        contentType: 1,
        bytes: [2],
      }),
    });
    const alphaSecond = coordinator.postGroupMessage({
      groupId: "group-alpha",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [3],
      }),
    });
    const betaSecond = coordinator.postGroupMessage({
      groupId: "group-beta",
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

  test("stores and returns pending join requests per group without draining", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.postGroupMessage({
      groupId: "group-alpha",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    coordinator.postGroupMessage({
      groupId: "group-beta",
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
    expect(fetchedAlpha[1]?.requesterStablePubkey).toBe("bob-requester");
    expect(fetchedAlpha[1]?.keyPackageRef).toBe("kp-ref-bob-1");

    expect(fetchedBeta).toHaveLength(1);
    expect(fetchedBeta[0]?.requesterStablePubkey).toBe("carol-requester");
    expect(fetchedBeta[0]?.keyPackageRef).toBe("kp-ref-carol-1");

    // Requests survive subsequent fetches (non-destructive).
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(2);
    expect(coordinator.fetchPendingJoinRequests("group-beta")).toHaveLength(1);
  });

  test("deduplicates join requests per group and requester, refreshing on re-request", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.postGroupMessage({
      groupId: "group-alpha",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });

    const first = coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });
    // The in-memory backend returns live references to its stored records, so
    // snapshot the original values before the refresh mutates the stored row.
    const firstCreatedAt = first.createdAt;

    const second = coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-2",
    });

    // A re-request refreshes the existing row in place: still one row (dedup),
    // but the keyPackageRef and createdAt are updated to the new values. The
    // bumped createdAt is what lets the request reappear for an admin who
    // already recorded a consume ref against the original createdAt.
    expect(second.keyPackageRef).toBe("kp-ref-alice-2");
    expect(second.createdAt).toBeGreaterThan(firstCreatedAt);

    // Fetching still returns only one request for alice, now with the refreshed
    // key package ref.
    const fetched = coordinator.fetchPendingJoinRequests("group-alpha");
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.requesterStablePubkey).toBe("alice-requester");
    expect(fetched[0]?.keyPackageRef).toBe("kp-ref-alice-2");
    expect(fetched[0]?.createdAt).toBe(second.createdAt);
  });

  test("a re-request evades a consume ref recorded against the original createdAt", () => {
    // Reproduces the user-reported bug: after leaving a group and re-requesting,
    // admins only saw the second send. Root cause was that storeJoinRequest
    // returned the stale row unchanged, so the admin's next fetch consumed it
    // (createdAt matched the accepted request) and returned nothing.
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.postGroupMessage({
      groupId: "group-alpha",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });

    const first = coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });

    // The admin accepts the original request and records a consume ref keyed
    // on its createdAt, but the retire (delete) only happens on the next
    // fetch — so the row is still pending on the coordinator here.
    const originalCreatedAt = first.createdAt;
    const consumedRef = {
      requesterStablePubkey: "alice-requester",
      createdAt: originalCreatedAt,
    };

    // Requester re-requests before the admin's consuming fetch fires.
    const refreshed = coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-2",
    });
    expect(refreshed.keyPackageRef).toBe("kp-ref-alice-2");
    expect(refreshed.createdAt).not.toBe(originalCreatedAt);

    // The admin's fetch carries the stale consume ref. Because the row's
    // createdAt was bumped, the consume does not match and the refreshed
    // request is returned — the admin sees the re-request on the first send.
    const fetched = coordinator.fetchPendingJoinRequests("group-alpha", [
      consumedRef,
    ]);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.keyPackageRef).toBe("kp-ref-alice-2");
  });

  test("allows a new join request only after the previous one is consumed", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.postGroupMessage({
      groupId: "group-alpha",
      opaqueMessage: createPrivateMessage({
        groupId: "group-alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });

    const first = coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });
    const firstCreatedAt = first.createdAt;

    // While the first request is still pending, a re-store refreshes it in
    // place (new keyPackageRef, bumped createdAt) rather than inserting a
    // duplicate row.
    const deduped = coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-2",
    });
    expect(deduped.keyPackageRef).toBe("kp-ref-alice-2");
    expect(deduped.createdAt).toBeGreaterThan(firstCreatedAt);

    // Observe without consuming does NOT insert another row.
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);

    // Consume (ack) the refreshed request via its new createdAt, then a new
    // one can be stored.
    coordinator.fetchPendingJoinRequests("group-alpha", [
      {
        requesterStablePubkey: "alice-requester",
        createdAt: deduped.createdAt,
      },
    ]);

    const newRequest = coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-3",
    });
    expect(newRequest.keyPackageRef).toBe("kp-ref-alice-3");

    const fetched = coordinator.fetchPendingJoinRequests("group-alpha");
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.keyPackageRef).toBe("kp-ref-alice-3");
  });

  test("observation never deletes join requests; maxAge is the only cleanup clock", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const maxAgeMs = 7_200_000; // 2h ceiling
    const coordinator = new Coordinator({
      storage,
      now: () => {
        tick += 1;
        return tick;
      },
      cleanupIntervalMs: 0,
      maxAgeMs: maxAgeMs,
    });

    coordinator.postGroupMessage({
      groupId: "group-alpha",
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

    // Observe — this used to start a short read-TTL deletion timer.
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);

    // Advance past the old 1h read-TTL window but stay within maxAge. Survives.
    tick += 3_700_000; // ~1h 2min
    expect(coordinator.deleteExpiredJoinRequests(tick - maxAgeMs)).toBe(0);
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);

    // Crossing the maxAge ceiling removes it.
    tick += maxAgeMs;
    expect(coordinator.deleteExpiredJoinRequests(tick - maxAgeMs)).toBe(1);
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(0);
  });

  test("does not delete join requests regardless of age", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const coordinator = new Coordinator({
      storage,
      now: () => {
        tick += 1;
        return tick;
      },
      cleanupIntervalMs: 0,
    });

    coordinator.postGroupMessage({
      groupId: "group-alpha",
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

    // Never fetched; only the maxAge ceiling can reap it.

    // Advance time well past any reasonable TTL.
    tick += 90_000_000; // 25 hours
    const deleted = coordinator.deleteExpiredJoinRequests(0);
    expect(deleted).toBe(0);

    // Unread request is still present.
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);
  });

  test("deletes join requests older than maxAgeMs", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const maxAgeMs = 3_600_000;
    const coordinator = new Coordinator({
      storage,
      now: () => {
        tick += 1;
        return tick;
      },
      cleanupIntervalMs: 0,
      maxAgeMs: maxAgeMs,
    });

    coordinator.postGroupMessage({
      groupId: "group-alpha",
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

    // Never fetch.
    tick += maxAgeMs + 60_000;
    const deleted = coordinator.deleteExpiredJoinRequests(tick - maxAgeMs);
    expect(deleted).toBe(1);
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(0);
  });

  test("keeps join requests younger than maxAgeMs", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const maxAgeMs = 3_600_000;
    const coordinator = new Coordinator({
      storage,
      now: () => {
        tick += 1;
        return tick;
      },
      cleanupIntervalMs: 0,
      maxAgeMs: maxAgeMs,
    });

    coordinator.postGroupMessage({
      groupId: "group-alpha",
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

    // Never fetch.
    tick += maxAgeMs - 60_000;
    const deleted = coordinator.deleteExpiredJoinRequests(tick - maxAgeMs);
    expect(deleted).toBe(0);
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);
  });

  test("deleteExpiredJoinRequests reaps by createdAt regardless of fetch", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const maxAgeMs = 7_200_000; // 2h ceiling
    const coordinator = new Coordinator({
      storage,
      now: () => {
        tick += 1;
        return tick;
      },
      cleanupIntervalMs: 0,
      maxAgeMs: maxAgeMs,
    });

    coordinator.postGroupMessage({
      groupId: "group-alpha",
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

    // Advance 2h then fetch (observation must not reset the clock).
    tick += 7_200_000; // 2 hours
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);

    // Advance another 30min. createdAt is ~2.5h old — past the 2h maxAge — so
    // it is deleted. Observation grants no immunity from the createdAt ceiling.
    tick += 1_800_000; // 30 minutes
    const deleted = coordinator.deleteExpiredJoinRequests(tick - maxAgeMs);
    expect(deleted).toBe(1);

    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(0);
  });

  test("cleanup timer deletes both expired welcomes and join requests in the same interval", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const maxAgeMs = 3_600_000; // 1h ceiling
    const coordinator = new Coordinator({
      storage,
      now: () => {
        tick += 1;
        return tick;
      },
      cleanupIntervalMs: 0,
      maxAgeMs: maxAgeMs,
    });

    coordinator.postGroupMessage({
      groupId: "group-alpha",
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

    // Fetch marks as read.
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);

    // Manually simulate what the cleanup timer would do: delete both
    // expired welcomes and join requests older than the maxAge ceiling.
    tick += maxAgeMs + 60_000;
    const threshold = tick - maxAgeMs;
    const deletedWelcomes = coordinator.deleteExpiredWelcomes(threshold);
    const deletedRequests = coordinator.deleteExpiredJoinRequests(threshold);

    // Both cleanup methods should have run (even if only requests were stored).
    expect(deletedWelcomes).toBe(0); // No welcomes stored
    expect(deletedRequests).toBe(1); // One expired request

    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(0);
  });

  test("rejects join requests when cap is reached", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    // Fill the group with join requests up to the cap.
    for (let i = 0; i < MAX_PENDING_JOIN_REQUESTS_PER_GROUP; i++) {
      coordinator.storeJoinRequest({
        groupId: "capped-group",
        requesterStablePubkey: `requester-${i}`,
        keyPackageRef: `kp-ref-${i}`,
      });
    }

    // The cap is reached; the next store should throw.
    expect(() =>
      coordinator.storeJoinRequest({
        groupId: "capped-group",
        requesterStablePubkey: "one-too-many",
        keyPackageRef: "kp-ref-overflow",
      }),
    ).toThrow("Too many pending join requests for this group");
  });

  test("allows join requests for groups with no messages (bootstrap)", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    // Store a join request for a group that has never had any messages posted.
    const record = coordinator.storeJoinRequest({
      groupId: "brand-new-group-no-messages",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });

    expect(record.groupId).toBe("brand-new-group-no-messages");
    expect(record.requesterStablePubkey).toBe("alice-requester");

    // The join request is fetchable even though the group has no routing entry.
    const fetched = coordinator.fetchPendingJoinRequests(
      "brand-new-group-no-messages",
    );
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.keyPackageRef).toBe("kp-ref-alice-1");
  });

  test("fetches many pending join requests across multiple groups", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

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

    // Results ordered by input group order.
    expect(results).toHaveLength(3);
    expect(results[0]?.groupId).toBe("group-alpha");
    expect(results[0]?.requesterStablePubkey).toBe("alice-requester");
    expect(results[1]?.groupId).toBe("group-alpha");
    expect(results[1]?.requesterStablePubkey).toBe("bob-requester");
    expect(results[2]?.groupId).toBe("group-beta");
    expect(results[2]?.requesterStablePubkey).toBe("carol-requester");

    // Subsequent single-group fetches return the same records (non-destructive).
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(2);
    expect(coordinator.fetchPendingJoinRequests("group-beta")).toHaveLength(1);
  });

  test("fetchManyPendingJoinRequests returns empty array for groups with no requests", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });

    const results = coordinator.fetchManyPendingJoinRequests({
      groups: [
        { groupId: "group-alpha" },
        { groupId: "group-empty" },
        { groupId: "group-beta" },
      ],
    });

    // Only group-alpha has a request.
    expect(results).toHaveLength(1);
    expect(results[0]?.groupId).toBe("group-alpha");
    expect(results[0]?.requesterStablePubkey).toBe("alice-requester");
  });

  test("consumed ack retires single-group join requests atomically on fetch", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

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

    const observed = coordinator.fetchPendingJoinRequests("group-alpha");
    expect(observed).toHaveLength(2);

    // Ack only alice; bob remains and is returned.
    const after = coordinator.fetchPendingJoinRequests("group-alpha", [
      {
        requesterStablePubkey: "alice-requester",
        createdAt: observed[0]!.createdAt,
      },
    ]);
    expect(after).toHaveLength(1);
    expect(after[0]?.requesterStablePubkey).toBe("bob-requester");
  });

  test("consumed ack retires join requests across groups via fetchMany", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-1",
    });
    coordinator.storeJoinRequest({
      groupId: "group-beta",
      requesterStablePubkey: "carol-requester",
      keyPackageRef: "kp-ref-carol-1",
    });

    const observed = coordinator.fetchManyPendingJoinRequests({
      groups: [{ groupId: "group-alpha" }, { groupId: "group-beta" }],
    });
    expect(observed).toHaveLength(2);

    // Ack carol in group-beta via fetchMany; only alpha remains.
    const after = coordinator.fetchManyPendingJoinRequests({
      groups: [{ groupId: "group-alpha" }, { groupId: "group-beta" }],
      consumed: [
        {
          groupId: "group-beta",
          requesterStablePubkey: "carol-requester",
          createdAt: observed[1]!.createdAt,
        },
      ],
    });
    expect(after).toHaveLength(1);
    expect(after[0]?.groupId).toBe("group-alpha");
    expect(after[0]?.requesterStablePubkey).toBe("alice-requester");
  });
});
