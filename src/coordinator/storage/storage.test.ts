import { afterEach, describe, expect, test } from "vitest";

import { Coordinator } from "../coordinator.ts";
import { InMemoryCoordinatorStorage } from "./inMemoryStorage.ts";
import { SqliteCoordinatorStorage } from "./sqliteStorage.ts";
import type { CoordinatorStorage } from "./storage.ts";
import {
  createActor,
  createKeyPackageRef,
  createMemberArtifacts,
  createWelcomeForNewMember,
  getTestCiphersuite,
} from "../testUtils.ts";
import {
  createGroup,
  encode,
  mlsMessageEncoder,
  unsafeTestingAuthenticationService,
  wireformats,
} from "ts-mls";

function createBytes(values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function createPrivateMessage(params: {
  epoch: bigint;
  contentType: 1 | 2 | 3;
  bytes: number[];
}): Uint8Array {
  return encode(mlsMessageEncoder, {
    version: 1,
    wireformat: wireformats.mls_private_message,
    privateMessage: {
      groupId: new TextEncoder().encode("group-local"),
      epoch: params.epoch,
      contentType: params.contentType,
      authenticatedData: new Uint8Array(),
      encryptedSenderData: new Uint8Array(),
      ciphertext: Uint8Array.from(params.bytes),
    },
  });
}

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
});
