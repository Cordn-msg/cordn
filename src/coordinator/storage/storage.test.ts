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
    const deleted = coordinator.deleteExpiredWelcomes(tick - 3_600_000, 0); // 1h TTL, unread preserved
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
    const deleted = coordinator.deleteExpiredWelcomes(tick - 3_600_000, 0);
    expect(deleted).toBe(0);

    // Unread welcome is still present.
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(1);
  });

  test("deletes unread welcomes older than welcomeMaxAgeMs", async () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    let tick = 1_700_000_000_000;
    const maxAgeMs = 3_600_000; // 1h max age for unread
    const coordinator = new Coordinator({
      storage,
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

    // Never fetch.
    tick += maxAgeMs + 60_000; // past maxAge
    const deleted = coordinator.deleteExpiredWelcomes(
      tick - 3_600_000,
      tick - maxAgeMs,
    );
    expect(deleted).toBe(1);
    expect(
      coordinator.fetchPendingWelcomes(bob.actor.stablePubkey),
    ).toHaveLength(0);
  });

  test("keeps unread welcomes younger than welcomeMaxAgeMs", async () => {
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

    // Never fetch.
    tick += maxAgeMs - 60_000; // within maxAge
    const deleted = coordinator.deleteExpiredWelcomes(
      tick - 3_600_000,
      tick - maxAgeMs,
    );
    expect(deleted).toBe(0);
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
    const deleted = coordinator.deleteExpiredWelcomes(tick - 3_600_000, 0); // 1h TTL, unread preserved
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

  test("filters group messages by sinceEpoch", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    const first = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "g",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    const second = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "g",
        epoch: 3n,
        contentType: 1,
        bytes: [2],
      }),
    });
    const third = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "g",
        epoch: 5n,
        contentType: 1,
        bytes: [3],
      }),
    });

    const all = coordinator.fetchGroupMessages({ groupId: "g" });
    expect(all.map((m) => m.cursor)).toEqual([
      first.cursor,
      second.cursor,
      third.cursor,
    ]);

    const fromEpoch3 = coordinator.fetchGroupMessages({
      groupId: "g",
      sinceEpoch: 3n,
    });
    expect(fromEpoch3.map((m) => m.cursor)).toEqual([
      second.cursor,
      third.cursor,
    ]);

    const fromEpoch5 = coordinator.fetchGroupMessages({
      groupId: "g",
      sinceEpoch: 5n,
    });
    expect(fromEpoch5.map((m) => m.cursor)).toEqual([third.cursor]);

    const fromEpoch10 = coordinator.fetchGroupMessages({
      groupId: "g",
      sinceEpoch: 10n,
    });
    expect(fromEpoch10).toEqual([]);
  });

  test("combines sinceEpoch with afterCursor", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "g",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    const second = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "g",
        epoch: 3n,
        contentType: 1,
        bytes: [2],
      }),
    });
    const third = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "g",
        epoch: 5n,
        contentType: 1,
        bytes: [3],
      }),
    });

    const result = coordinator.fetchGroupMessages({
      groupId: "g",
      afterCursor: second.cursor,
      sinceEpoch: 3n,
    });
    expect(result.map((m) => m.cursor)).toEqual([third.cursor]);
  });

  test("fetchManyGroupMessages respects per-group sinceEpoch", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    const alpha1 = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "alpha",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "alpha",
        epoch: 5n,
        contentType: 1,
        bytes: [2],
      }),
    });
    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "beta",
        epoch: 1n,
        contentType: 1,
        bytes: [3],
      }),
    });
    const beta2 = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "beta",
        epoch: 5n,
        contentType: 1,
        bytes: [4],
      }),
    });

    const result = coordinator.fetchManyGroupMessages({
      groups: [
        { groupId: "alpha", afterCursor: alpha1.cursor, sinceEpoch: 5n },
        { groupId: "beta", sinceEpoch: 5n },
      ],
    });
    expect(result.map((m) => [m.groupId, m.cursor])).toEqual([
      ["alpha", alpha1.cursor + 1],
      ["beta", beta2.cursor],
    ]);
  });

  test("sinceEpoch of 0 returns all messages", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "g",
        epoch: 1n,
        contentType: 1,
        bytes: [1],
      }),
    });
    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "g",
        epoch: 3n,
        contentType: 1,
        bytes: [2],
      }),
    });

    const result = coordinator.fetchGroupMessages({
      groupId: "g",
      sinceEpoch: 0n,
    });
    expect(result).toHaveLength(2);
  });

  test("sinceEpoch > 0 excludes messages with epoch 0n", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "g",
        epoch: 0n,
        contentType: 1,
        bytes: [1],
      }),
    });
    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "g",
        epoch: 5n,
        contentType: 1,
        bytes: [2],
      }),
    });

    // sinceEpoch > 0 must exclude epoch 0n messages
    const filtered = coordinator.fetchGroupMessages({
      groupId: "g",
      sinceEpoch: 3n,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.epoch).toBe(5n);

    // sinceEpoch = 0 includes everything (backward compat)
    const all = coordinator.fetchGroupMessages({
      groupId: "g",
      sinceEpoch: 0n,
    });
    expect(all).toHaveLength(2);
  });

  test("fetchManyGroupMessages excludes 0n epoch messages per group with sinceEpoch > 0", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "alpha",
        epoch: 0n,
        contentType: 1,
        bytes: [1],
      }),
    });
    const alpha5 = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "alpha",
        epoch: 5n,
        contentType: 1,
        bytes: [2],
      }),
    });
    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "beta",
        epoch: 0n,
        contentType: 1,
        bytes: [3],
      }),
    });
    const beta5 = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "sender",
      opaqueMessage: createPrivateMessage({
        groupId: "beta",
        epoch: 5n,
        contentType: 1,
        bytes: [4],
      }),
    });

    const result = coordinator.fetchManyGroupMessages({
      groups: [
        { groupId: "alpha", sinceEpoch: 3n },
        { groupId: "beta", sinceEpoch: 3n },
      ],
    });
    expect(result.map((m) => [m.groupId, m.cursor])).toEqual([
      ["alpha", alpha5.cursor],
      ["beta", beta5.cursor],
    ]);
  });

  test("stores and returns pending join requests per group without draining", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

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

  test("deduplicates join requests per group and requester", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "member-1",
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

    const second = coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-2",
    });

    // Second call returns the same record (dedup by unread request).
    expect(second.keyPackageRef).toBe(first.keyPackageRef);
    expect(second.createdAt).toBe(first.createdAt);

    // Fetching still returns only one request for alice.
    const fetched = coordinator.fetchPendingJoinRequests("group-alpha");
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.requesterStablePubkey).toBe("alice-requester");
    expect(fetched[0]?.keyPackageRef).toBe("kp-ref-alice-1");
  });

  test("allows new join request after previous one was read", () => {
    const storage = createStorage();
    closers.add(() => storage.close?.());
    const coordinator = createCoordinatorWithStorage(storage);

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

    // Fetch marks as read.
    coordinator.fetchPendingJoinRequests("group-alpha");

    // Now a new request with a new kp_ref can be stored (old one is read).
    const newRequest = coordinator.storeJoinRequest({
      groupId: "group-alpha",
      requesterStablePubkey: "alice-requester",
      keyPackageRef: "kp-ref-alice-2",
    });

    expect(newRequest.keyPackageRef).toBe("kp-ref-alice-2");

    const fetched = coordinator.fetchPendingJoinRequests("group-alpha");
    // Both the old (read) and new (unread) requests are returned.
    expect(fetched).toHaveLength(2);
  });

  test("deletes read join requests that exceed TTL", () => {
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

    // Fetch marks the request as read.
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);

    // Advance time past the 1h default TTL.
    tick += 3_700_000; // ~1h 2min
    const deleted = coordinator.deleteExpiredJoinRequests(tick - 3_600_000, 0); // 1h TTL, unread preserved
    expect(deleted).toBe(1);

    // Request is gone after cleanup.
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(0);
  });

  test("does not delete unread join requests regardless of age", () => {
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

    // Never fetch.
    tick += maxAgeMs + 60_000;
    const deleted = coordinator.deleteExpiredJoinRequests(
      tick - 3_600_000,
      tick - maxAgeMs,
    );
    expect(deleted).toBe(1);
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(0);
  });

  test("keeps unread join requests younger than welcomeMaxAgeMs", () => {
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

    // Never fetch.
    tick += maxAgeMs - 60_000;
    const deleted = coordinator.deleteExpiredJoinRequests(
      tick - 3_600_000,
      tick - maxAgeMs,
    );
    expect(deleted).toBe(0);
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);
  });

  test("deleteExpiredJoinRequests uses readAt timestamp, not createdAt", () => {
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

    // Advance time 2 hours before fetching.
    tick += 7_200_000; // 2 hours

    // Now fetch — this sets readAt to now (2h after createdAt).
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);

    // Advance only 30min past readAt — only 30min old by readAt.
    tick += 1_800_000; // 30 minutes
    const deleted = coordinator.deleteExpiredJoinRequests(tick - 3_600_000, 0); // 1h TTL, unread preserved
    expect(deleted).toBe(0);

    // Request is still present.
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);
  });

  test("cleanup timer deletes both expired welcomes and join requests in the same interval", () => {
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

    // Fetch marks as read.
    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(1);

    // Manually simulate what the cleanup timer would do: delete both
    // expired welcomes and join requests with the same threshold.
    tick += 3_700_000; // ~1h 2min
    const threshold = tick - 3_600_000; // 1h TTL
    const deletedWelcomes = coordinator.deleteExpiredWelcomes(threshold, 0);
    const deletedRequests = coordinator.deleteExpiredJoinRequests(threshold, 0);

    // Both cleanup methods should have run (even if only requests were stored).
    expect(deletedWelcomes).toBe(0); // No welcomes stored
    expect(deletedRequests).toBe(1); // One read+expired request

    expect(coordinator.fetchPendingJoinRequests("group-alpha")).toHaveLength(0);
  });
});
