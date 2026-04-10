import { afterEach, describe, expect, test } from "vitest"
import {
  encode,
  defaultProposalTypes,
  keyPackageEncoder,
  processMessage,
  protocolVersions,
  unsafeTestingAuthenticationService,
  wireformats,
  mlsMessageEncoder,
} from "ts-mls"

import { CvmMlsDeliveryServiceClient } from "./CvmMlsDeliveryServiceClient.ts"
import {
  connectContextVmCoordinatorServer,
  createDefaultServerSigner,
} from "../../server/contextvmCoordinatorServer.ts"
import {
  createApplicationMessageBytes,
  createCommitMessageBytes,
  createProposalMessageBytes,
  createThreeActorGroupScenario,
  decodeMlsFramedMessage,
  getTestCiphersuite,
  processMessageBytes,
} from "../../coordinator/testUtils.ts"

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"))
}

async function createClient(params: {
  privateKey: Uint8Array
  serverPubkey: string
  relays: string[]
}): Promise<CvmMlsDeliveryServiceClient> {
  return new CvmMlsDeliveryServiceClient({
    privateKey: bytesToHex(params.privateKey),
    serverPubkey: params.serverPubkey,
    relays: params.relays,
  })
}

describe("CvmMlsDeliveryServiceClient integration flow", () => {
  const clients: CvmMlsDeliveryServiceClient[] = []
  const relayUrls = ["wss://relay.contextvm.org"]

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.disconnect()))
  })

  test("supports an alice, bob, and carol invitation and delivery scenario through the real ContextVM interface", async () => {
    const serverSigner = createDefaultServerSigner()
    const serverPubkey = await serverSigner.getPublicKey()
    const server = await connectContextVmCoordinatorServer({
      signer: serverSigner,
      relayUrls,
    })

    try {
      const scenario = await createThreeActorGroupScenario()
      const { alice, bob, carol } = scenario

      const aliceClient = await createClient({
        privateKey: alice.actor.secretKey,
        serverPubkey,
        relays: relayUrls,
      })
      const bobClient = await createClient({
        privateKey: bob.actor.secretKey,
        serverPubkey,
        relays: relayUrls,
      })
      const carolClient = await createClient({
        privateKey: carol.actor.secretKey,
        serverPubkey,
        relays: relayUrls,
      })

      clients.push(aliceClient, bobClient, carolClient)

      const bobPublished = await bobClient.PublishKeyPackage(
        scenario.bobKeyPackageRef,
        encodeBase64(encode(keyPackageEncoder, scenario.bob.keyPackage)),
      )
      const carolPublished = await carolClient.PublishKeyPackage(
        scenario.carolKeyPackageRef,
        encodeBase64(encode(keyPackageEncoder, scenario.carol.keyPackage)),
      )

      const consumedBob = await aliceClient.ConsumeKeyPackageForIdentity(bob.actor.stablePubkey)
      const consumedCarol = await aliceClient.ConsumeKeyPackageForIdentity(carol.actor.stablePubkey)

      expect(consumedBob.keyPackage?.keyPackageId).toBe(bobPublished.keyPackageId)
      expect(consumedCarol.keyPackage?.keyPackageId).toBe(carolPublished.keyPackageId)

      const bobStoredWelcome = await aliceClient.StoreWelcome(
        bob.actor.stablePubkey,
        scenario.bobKeyPackageRef,
        encodeBase64(encode(mlsMessageEncoder, {
          version: protocolVersions.mls10,
          wireformat: wireformats.mls_welcome,
          welcome: scenario.bobWelcome,
        })),
      )
      const carolStoredWelcome = await aliceClient.StoreWelcome(
        carol.actor.stablePubkey,
        scenario.carolKeyPackageRef,
        encodeBase64(encode(mlsMessageEncoder, {
          version: protocolVersions.mls10,
          wireformat: wireformats.mls_welcome,
          welcome: scenario.carolWelcome,
        })),
      )

      const bobWelcomes = await bobClient.FetchPendingWelcomes({})
      const carolWelcomes = await carolClient.FetchPendingWelcomes({})

      expect(bobWelcomes.welcomes).toHaveLength(1)
      expect(carolWelcomes.welcomes).toHaveLength(1)
      expect(bobWelcomes.welcomes[0]?.welcomeId).toBe(bobStoredWelcome.welcomeId)
      expect(carolWelcomes.welcomes[0]?.welcomeId).toBe(carolStoredWelcome.welcomeId)
      expect((await bobClient.FetchPendingWelcomes({})).welcomes).toEqual([])
      expect((await carolClient.FetchPendingWelcomes({})).welcomes).toEqual([])

      const postedCommit = await aliceClient.PostGroupMessage(encodeBase64(scenario.commitMessageBytes))
      const postedAliceMessage = await aliceClient.PostGroupMessage(encodeBase64(scenario.aliceApplicationBytes))
      const postedBobMessage = await bobClient.PostGroupMessage(encodeBase64(scenario.bobApplicationBytes))

      const allMessages = await aliceClient.FetchGroupMessages(postedCommit.groupId)
      const newerMessages = await aliceClient.FetchGroupMessages(postedCommit.groupId, postedCommit.cursor)

      expect(allMessages.messages).toHaveLength(3)
      expect(newerMessages.messages).toHaveLength(2)
      expect(newerMessages.messages[0]?.cursor).toBe(postedAliceMessage.cursor)
      expect(newerMessages.messages[1]?.cursor).toBe(postedBobMessage.cursor)

      expect(server.coordinator.snapshot()).toEqual({
        stableIdentities: 0,
        publishedKeyPackages: 0,
        pendingWelcomes: 0,
        trackedGroups: 1,
        queuedMessages: 3,
      })
    } finally {
      await server.transport.close()
    }
  })

  test("round-trips queued application messages through the real ContextVM interface", async () => {
    const serverSigner = createDefaultServerSigner()
    const serverPubkey = await serverSigner.getPublicKey()
    const server = await connectContextVmCoordinatorServer({
      signer: serverSigner,
      relayUrls,
    })

    try {
      const scenario = await createThreeActorGroupScenario()

      const aliceClient = await createClient({
        privateKey: scenario.alice.actor.secretKey,
        serverPubkey,
        relays: relayUrls,
      })
      const bobClient = await createClient({
        privateKey: scenario.bob.actor.secretKey,
        serverPubkey,
        relays: relayUrls,
      })
      const carolClient = await createClient({
        privateKey: scenario.carol.actor.secretKey,
        serverPubkey,
        relays: relayUrls,
      })

      clients.push(aliceClient, bobClient, carolClient)

      const posted = await aliceClient.PostGroupMessage(encodeBase64(scenario.aliceApplicationBytes))
      const fetched = await bobClient.FetchGroupMessages(posted.groupId)
      const [message] = fetched.messages

      expect(message?.cursor).toBe(posted.cursor)

      const bobResult = await processMessageBytes({
        state: scenario.bob.state,
        encodedMessage: decodeBase64(message!.opaqueMessageBase64),
      })
      const carolResult = await processMessageBytes({
        state: scenario.carol.state,
        encodedMessage: decodeBase64(message!.opaqueMessageBase64),
      })

      expect(bobResult.kind).toBe("applicationMessage")
      expect(carolResult.kind).toBe("applicationMessage")
      if (bobResult.kind !== "applicationMessage" || carolResult.kind !== "applicationMessage") {
        throw new Error("Expected application message results")
      }

      expect(new TextDecoder().decode(bobResult.message)).toBe("hello from alice")
      expect(new TextDecoder().decode(carolResult.message)).toBe("hello from alice")
    } finally {
      await server.transport.close()
    }
  })

  test("preserves ordered queue semantics across proposal, commit, and application traffic through the real ContextVM interface", async () => {
    const serverSigner = createDefaultServerSigner()
    const serverPubkey = await serverSigner.getPublicKey()
    const server = await connectContextVmCoordinatorServer({
      signer: serverSigner,
      relayUrls,
    })

    try {
      const scenario = await createThreeActorGroupScenario()
      const cipherSuite = await getTestCiphersuite()
      const bobClient = await createClient({
        privateKey: scenario.bob.actor.secretKey,
        serverPubkey,
        relays: relayUrls,
      })
      const aliceClient = await createClient({
        privateKey: scenario.alice.actor.secretKey,
        serverPubkey,
        relays: relayUrls,
      })

      clients.push(aliceClient, bobClient)

      const proposal = await createProposalMessageBytes({
        state: scenario.alice.state,
        proposal: {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: 2 },
        },
        wireAsPublicMessage: true,
      })
      const postedProposal = await aliceClient.PostGroupMessage(encodeBase64(proposal.encodedMessage))

      const commit = await createCommitMessageBytes({
        state: proposal.newState,
      })
      const postedCommit = await aliceClient.PostGroupMessage(encodeBase64(commit.encodedMessage))

      const application = await createApplicationMessageBytes({
        state: commit.newState,
        plaintext: "ordered traffic",
      })
      const postedApplication = await bobClient.PostGroupMessage(encodeBase64(application.encodedMessage))

      const queued = await bobClient.FetchGroupMessages(postedProposal.groupId)
      expect(queued.messages.map((message) => message.cursor)).toEqual([
        postedProposal.cursor,
        postedCommit.cursor,
        postedApplication.cursor,
      ])

      const bobProposalResult = await processMessage({
        context: { cipherSuite, authService: unsafeTestingAuthenticationService },
        state: scenario.bob.state,
        message: decodeMlsFramedMessage(decodeBase64(queued.messages[0]!.opaqueMessageBase64)),
      })
      expect(bobProposalResult.kind).toBe("newState")
      if (bobProposalResult.kind !== "newState") {
        throw new Error("Expected public proposal to update state")
      }

      const bobCommitResult = await processMessage({
        context: { cipherSuite, authService: unsafeTestingAuthenticationService },
        state: bobProposalResult.newState,
        message: decodeMlsFramedMessage(decodeBase64(queued.messages[1]!.opaqueMessageBase64)),
      })
      expect(bobCommitResult.kind).toBe("newState")
      if (bobCommitResult.kind !== "newState") {
        throw new Error("Expected commit to update state")
      }

      const bobApplicationResult = await processMessage({
        context: { cipherSuite, authService: unsafeTestingAuthenticationService },
        state: bobCommitResult.newState,
        message: decodeMlsFramedMessage(decodeBase64(queued.messages[2]!.opaqueMessageBase64)),
      })
      expect(bobApplicationResult.kind).toBe("applicationMessage")
      if (bobApplicationResult.kind !== "applicationMessage") {
        throw new Error("Expected ordered application delivery")
      }

      expect(new TextDecoder().decode(bobApplicationResult.message)).toBe("ordered traffic")
    } finally {
      await server.transport.close()
    }
  })
})
