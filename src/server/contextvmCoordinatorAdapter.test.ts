import { describe, expect, test } from "vitest"
import {
  createGroup,
  encode,
  keyPackageEncoder,
  mlsMessageEncoder,
  protocolVersions,
  unsafeTestingAuthenticationService,
  wireformats,
} from "ts-mls"

import { DeliveryServiceCoordinator } from "../coordinator/deliveryServiceCoordinator"
import {
  createApplicationMessageBytes,
  createMemberArtifacts,
  createWelcomeForNewMember,
  createActor,
  getTestCiphersuite,
} from "../coordinator/testUtils"
import { ContextVmCoordinatorAdapter } from "./contextvmCoordinatorAdapter"
import { encodeBase64 } from "./base64"

function encodeWelcomeAsBase64(welcome: Parameters<typeof encodeWelcomeRecord>[0]): string {
  return encodeBase64(encodeWelcomeRecord(welcome))
}

function encodeWelcomeRecord(welcome: { welcome: import("ts-mls").Welcome }): Uint8Array
function encodeWelcomeRecord(welcome: import("ts-mls").Welcome): Uint8Array
function encodeWelcomeRecord(welcome: import("ts-mls").Welcome | { welcome: import("ts-mls").Welcome }): Uint8Array {
  const value = "welcome" in welcome ? welcome.welcome : welcome

  return encode(mlsMessageEncoder, {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_welcome,
    welcome: value,
  })
}

function createExtra(clientPubkey?: string) {
  return {
    _meta: clientPubkey ? { clientPubkey } : {},
  } as never
}

describe("ContextVmCoordinatorAdapter", () => {
  test("maps injected client identity into self-scoped operations", async () => {
    const coordinator = new DeliveryServiceCoordinator()
    const adapter = new ContextVmCoordinatorAdapter(coordinator)
    const alice = await createMemberArtifacts(createActor("alice"))

    const published = adapter.publishKeyPackage(
      {
        keyPackageRef: "kp-ref-alice",
        keyPackageBase64: encodeBase64(encode(keyPackageEncoder, alice.keyPackage)),
      },
      createExtra(alice.actor.stablePubkey),
    )

    expect(published.content).toEqual([])
    expect(published.structuredContent.keyPackageRef).toBe("kp-ref-alice")

    const consumed = adapter.consumeKeyPackageForIdentity({
      stablePubkey: alice.actor.stablePubkey,
    })

    expect(consumed.content).toEqual([])
    expect(consumed.structuredContent.keyPackage?.stablePubkey).toBe(alice.actor.stablePubkey)
    expect(consumed.structuredContent.keyPackage?.keyPackageRef).toBe("kp-ref-alice")
  })

  test("lists available key packages without consuming them", async () => {
    const coordinator = new DeliveryServiceCoordinator()
    const adapter = new ContextVmCoordinatorAdapter(coordinator)
    const alice = await createMemberArtifacts(createActor("alice"))
    const bob = await createMemberArtifacts(createActor("bob"))

    adapter.publishKeyPackage(
      {
        keyPackageRef: "kp-ref-alice",
        keyPackageBase64: encodeBase64(encode(keyPackageEncoder, alice.keyPackage)),
      },
      createExtra(alice.actor.stablePubkey),
    )

    adapter.publishKeyPackage(
      {
        keyPackageRef: "kp-ref-bob",
        keyPackageBase64: encodeBase64(encode(keyPackageEncoder, bob.keyPackage)),
      },
      createExtra(bob.actor.stablePubkey),
    )

    const listed = adapter.listAvailableKeyPackages({})

    expect(listed.content).toEqual([])
    expect(listed.structuredContent.keyPackages).toHaveLength(2)
    expect(listed.structuredContent.keyPackages.map((entry) => entry.stablePubkey)).toEqual([
      alice.actor.stablePubkey,
      bob.actor.stablePubkey,
    ])

    const consumed = adapter.consumeKeyPackageForIdentity({ stablePubkey: alice.actor.stablePubkey })
    expect(consumed.structuredContent.keyPackage?.stablePubkey).toBe(alice.actor.stablePubkey)
  })

  test("rejects missing injected client pubkey on self-scoped operations", async () => {
    const coordinator = new DeliveryServiceCoordinator()
    const adapter = new ContextVmCoordinatorAdapter(coordinator)
    const alice = await createMemberArtifacts(createActor("alice"))

    expect(() =>
      adapter.publishKeyPackage(
        {
          keyPackageRef: "kp-ref-alice",
          keyPackageBase64: encodeBase64(encode(keyPackageEncoder, alice.keyPackage)),
        },
        createExtra(),
      ),
    ).toThrowError("Missing injected client pubkey")
  })

  test("rejects invalid base64 and malformed payloads", async () => {
    const coordinator = new DeliveryServiceCoordinator()
    const adapter = new ContextVmCoordinatorAdapter(coordinator)
    const alice = await createMemberArtifacts(createActor("alice"))

    expect(() =>
      adapter.publishKeyPackage(
        {
          keyPackageRef: "kp-ref-alice",
          keyPackageBase64: "!!!",
        },
        createExtra(alice.actor.stablePubkey),
      ),
    ).toThrowError("Invalid keyPackageBase64")

    expect(() =>
      adapter.postGroupMessage(
        {
          opaqueMessageBase64: encodeBase64(Uint8Array.from([1, 2, 3])),
        },
        createExtra(alice.actor.stablePubkey),
      ),
    ).toThrowError("Invalid opaqueMessageBase64")
  })

  test("round-trips welcomes and queued group messages as base64 structured outputs", async () => {
    const coordinator = new DeliveryServiceCoordinator()
    const adapter = new ContextVmCoordinatorAdapter(coordinator)
    const alice = await createMemberArtifacts(createActor("alice"))
    const bob = await createMemberArtifacts(createActor("bob"))
    const cipherSuite = await getTestCiphersuite()
    const aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: new TextEncoder().encode("group-alice-bob"),
      keyPackage: alice.keyPackage,
      privateKeyPackage: alice.privateKeyPackage,
    })

    const group = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bob,
    })

    const stored = adapter.storeWelcome({
      targetStablePubkey: bob.actor.stablePubkey,
      keyPackageReference: group.keyPackageRefHex,
      welcomeBase64: encodeWelcomeAsBase64(group.welcome),
    })

    expect(stored.content).toEqual([])
    expect(stored.structuredContent.welcomeId).toBeTypeOf("string")

    const fetchedWelcomes = adapter.fetchPendingWelcomes({}, createExtra(bob.actor.stablePubkey))
    expect(fetchedWelcomes.structuredContent.welcomes).toHaveLength(1)
    expect(fetchedWelcomes.structuredContent.welcomes[0]?.keyPackageReference).toBe(group.keyPackageRefHex)

    const messageBytes = await createApplicationMessageBytes({
      state: group.senderState,
      plaintext: "hello from alice",
    })

    const posted = adapter.postGroupMessage(
      {
        opaqueMessageBase64: encodeBase64(messageBytes.encodedMessage),
      },
      createExtra(alice.actor.stablePubkey),
    )

    expect(posted.content).toEqual([])

    const fetchedMessages = adapter.fetchGroupMessages({
      groupId: posted.structuredContent.groupId,
    })

    expect(fetchedMessages.content).toEqual([])
    expect(fetchedMessages.structuredContent.messages).toHaveLength(1)
    expect(fetchedMessages.structuredContent.messages[0]?.opaqueMessageBase64).toBe(
      encodeBase64(messageBytes.encodedMessage),
    )
  })
})
