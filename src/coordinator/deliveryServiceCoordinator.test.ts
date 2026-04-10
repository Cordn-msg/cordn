import { describe, expect, test } from "vitest"
import { encode, mlsMessageEncoder, wireformats } from "ts-mls"

import { DeliveryServiceCoordinator } from "./deliveryServiceCoordinator"
import { createActor, createKeyPackageRef, createMemberArtifacts, createWelcomeForNewMember, getTestCiphersuite } from "./testUtils"
import { createGroup, unsafeTestingAuthenticationService } from "ts-mls"

function createBytes(values: number[]): Uint8Array {
  return Uint8Array.from(values)
}

function createPrivateMessage(params: { epoch: bigint; contentType: 1 | 2 | 3; bytes: number[] }): Uint8Array {
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
  })
}

describe("DeliveryServiceCoordinator key package flow", () => {
  test("publishes, lists, consumes, and snapshots key packages in FIFO order", async () => {
    const coordinator = new DeliveryServiceCoordinator()
    const alice = await createMemberArtifacts(createActor("alice-unit"))
    const stablePubkey = alice.actor.stablePubkey
    const firstKeyPackageRef = await createKeyPackageRef(alice.keyPackage)
    const second = await createMemberArtifacts(createActor("alice-unit-next"))
    const secondKeyPackageRef = await createKeyPackageRef(second.keyPackage)

    const firstRecord = coordinator.publishKeyPackage({
      stablePubkey,
      keyPackage: alice.keyPackage,
      keyPackageRef: firstKeyPackageRef,
    })

    const secondRecord = coordinator.publishKeyPackage({
      stablePubkey,
      keyPackage: second.keyPackage,
      keyPackageRef: secondKeyPackageRef,
    })

    const listed = coordinator.listKeyPackagesForIdentity(stablePubkey)

    expect(listed).toHaveLength(2)
    expect(listed[0]?.id).toBe(firstRecord.id)
    expect(listed[1]?.id).toBe(secondRecord.id)
    expect(coordinator.snapshot()).toMatchObject({
      stableIdentities: 1,
      publishedKeyPackages: 2,
    })

    const consumedFirst = coordinator.consumeKeyPackageForIdentity(stablePubkey)
    const consumedSecond = coordinator.consumeKeyPackageForIdentity(stablePubkey)
    const consumedEmpty = coordinator.consumeKeyPackageForIdentity(stablePubkey)

    expect(consumedFirst?.id).toBe(firstRecord.id)
    expect(consumedSecond?.id).toBe(secondRecord.id)
    expect(consumedEmpty).toBeNull()
    expect(coordinator.listKeyPackagesForIdentity(stablePubkey)).toEqual([])
    expect(coordinator.snapshot()).toMatchObject({
      stableIdentities: 0,
      publishedKeyPackages: 0,
    })
  })

  test("lists all available key packages across identities", async () => {
    const coordinator = new DeliveryServiceCoordinator()
    const alice = await createMemberArtifacts(createActor("alice-global"))
    const bob = await createMemberArtifacts(createActor("bob-global"))
    const aliceKeyPackageRef = await createKeyPackageRef(alice.keyPackage)
    const bobKeyPackageRef = await createKeyPackageRef(bob.keyPackage)

    const aliceRecord = coordinator.publishKeyPackage({
      stablePubkey: alice.actor.stablePubkey,
      keyPackage: alice.keyPackage,
      keyPackageRef: aliceKeyPackageRef,
    })

    const bobRecord = coordinator.publishKeyPackage({
      stablePubkey: bob.actor.stablePubkey,
      keyPackage: bob.keyPackage,
      keyPackageRef: bobKeyPackageRef,
    })

    expect(coordinator.listAllKeyPackages().map((record) => record.id)).toEqual([aliceRecord.id, bobRecord.id])
  })
})

describe("DeliveryServiceCoordinator welcome flow", () => {
  test("stores and drains queued welcomes per target identity", async () => {
    const coordinator = new DeliveryServiceCoordinator()
    const alice = await createMemberArtifacts(createActor("alice-unit"))
    const bob = await createMemberArtifacts(createActor("bob-unit"))
    const carol = await createMemberArtifacts(createActor("carol-unit"))
    const cipherSuite = await getTestCiphersuite()
    let aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("welcome-flow"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    })
    const firstFixture = await createWelcomeForNewMember({ senderState: aliceState, member: bob })
    aliceState = firstFixture.senderState
    const secondFixture = await createWelcomeForNewMember({ senderState: aliceState, member: carol })

    const firstWelcome = coordinator.storeWelcome({
      targetStablePubkey: bob.actor.stablePubkey,
      keyPackageReference: firstFixture.keyPackageRefHex,
      welcome: firstFixture.welcome,
    })

    const secondWelcome = coordinator.storeWelcome({
      targetStablePubkey: carol.actor.stablePubkey,
      keyPackageReference: secondFixture.keyPackageRefHex,
      welcome: secondFixture.welcome,
    })

    expect(coordinator.snapshot()).toMatchObject({
      pendingWelcomes: 2,
    })

    const fetchedBob = coordinator.fetchPendingWelcomes(bob.actor.stablePubkey)
    const fetchedCarol = coordinator.fetchPendingWelcomes(carol.actor.stablePubkey)

    expect(fetchedBob).toHaveLength(1)
    expect(fetchedBob[0]?.id).toBe(firstWelcome.id)
    expect(fetchedCarol).toHaveLength(1)
    expect(fetchedCarol[0]?.id).toBe(secondWelcome.id)
    expect(coordinator.fetchPendingWelcomes(bob.actor.stablePubkey)).toEqual([])
    expect(coordinator.fetchPendingWelcomes(carol.actor.stablePubkey)).toEqual([])
    expect(coordinator.snapshot()).toMatchObject({
      pendingWelcomes: 0,
    })
  })
})

describe("DeliveryServiceCoordinator group message flow", () => {
  test("stores defensive byte copies and supports cursor-based fetches", () => {
    const coordinator = new DeliveryServiceCoordinator()
    const originalPayload = createBytes([1, 2, 3])

    const firstMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice-ephemeral-1",
      opaqueMessage: createPrivateMessage({ epoch: 1n, contentType: 1, bytes: Array.from(originalPayload) }),
    })

    originalPayload[0] = 99
    firstMessage.opaqueMessage[1] = 77

    const secondMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: "bob-ephemeral-1",
      opaqueMessage: createPrivateMessage({ epoch: 1n, contentType: 1, bytes: [4, 5, 6] }),
    })

    expect(firstMessage.groupId).toBe("group-local")
    expect(secondMessage.groupId).toBe("group-local")

    const fetchedAll = coordinator.fetchGroupMessages({ groupId: "group-local" })

    expect(fetchedAll).toHaveLength(2)
    expect(Array.from(fetchedAll[0]?.opaqueMessage ?? [])).toEqual(
      Array.from(createPrivateMessage({ epoch: 1n, contentType: 1, bytes: [1, 2, 3] })),
    )
    expect(Array.from(fetchedAll[1]?.opaqueMessage ?? [])).toEqual(
      Array.from(createPrivateMessage({ epoch: 1n, contentType: 1, bytes: [4, 5, 6] })),
    )

    fetchedAll[0]?.opaqueMessage.set([8, 8, 8])

    const fetchedAgain = coordinator.fetchGroupMessages({ groupId: "group-local" })
    const fetchedAfterCursor = coordinator.fetchGroupMessages({
      groupId: "group-local",
      afterCursor: firstMessage.cursor,
    })

    expect(Array.from(fetchedAgain[0]?.opaqueMessage ?? [])).toEqual(
      Array.from(createPrivateMessage({ epoch: 1n, contentType: 1, bytes: [1, 2, 3] })),
    )
    expect(fetchedAfterCursor).toHaveLength(1)
    expect(fetchedAfterCursor[0]?.cursor).toBe(secondMessage.cursor)
    expect(coordinator.snapshot()).toMatchObject({
      trackedGroups: 1,
      queuedMessages: 2,
    })
  })

  test("tracks handshake epochs and rejects stale handshake traffic", () => {
    const coordinator = new DeliveryServiceCoordinator()

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "alice-ephemeral-2",
      opaqueMessage: createPrivateMessage({ epoch: 5n, contentType: 3, bytes: [10, 11] }),
    })

    coordinator.postGroupMessage({
      ephemeralSenderPubkey: "bob-ephemeral-2",
      opaqueMessage: createPrivateMessage({ epoch: 5n, contentType: 1, bytes: [12, 13] }),
    })

    expect(coordinator.getGroupRouting("group-local")).toEqual({
      groupId: "group-local",
      latestHandshakeEpoch: 5n,
      lastMessageCursor: 2,
    })

    expect(() =>
      coordinator.postGroupMessage({
        ephemeralSenderPubkey: "carol-ephemeral-2",
        opaqueMessage: createPrivateMessage({ epoch: 4n, contentType: 2, bytes: [14, 15] }),
      }),
    ).toThrow("Rejected stale handshake message")

    expect(coordinator.getGroupRouting("unknown-group")).toBeNull()
  })
})
