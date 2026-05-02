import { afterEach, describe, expect, test } from "vitest";
import {
  encode,
  defaultProposalTypes,
  keyPackageEncoder,
  processMessage,
  protocolVersions,
  unsafeTestingAuthenticationService,
  wireformats,
  mlsMessageEncoder,
} from "ts-mls";

import { connectServer } from "../server/coordinatorServer.ts";
import { MockRelayHub } from "../test/mockRelay.ts";
import {
  createApplicationMessageBytes,
  createCommitMessageBytes,
  createProposalMessageBytes,
  createThreeActorGroupScenario,
  decodeMlsFramedMessage,
  getTestCiphersuite,
  processMessageBytes,
} from "../coordinator/testUtils.ts";
import { PrivateKeySigner, type RelayHandler } from "@contextvm/sdk";
import { bytesToHex } from "nostr-tools/utils";
import { decodeBase64, encodeBase64 } from "../server/base64.ts";
import { cordnClient } from "./coordinatorClient.ts";

async function createClient(params: {
  privateKey: Uint8Array;
  serverPubkey: string;
  relayHandler: RelayHandler;
}): Promise<cordnClient> {
  return new cordnClient({
    privateKey: bytesToHex(params.privateKey),
    serverPubkey: params.serverPubkey,
    relayHandler: params.relayHandler,
  });
}

describe("CvmMlsDeliveryServiceClient integration flow", () => {
  const clients: cordnClient[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      clients.splice(0).map((client) => client.disconnect()),
    );
  });

  test("supports an alice, bob, and carol invitation and delivery scenario through the real ContextVM interface", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const scenario = await createThreeActorGroupScenario();
      const { alice, bob, carol } = scenario;

      const aliceClient = await createClient({
        privateKey: alice.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bobClient = await createClient({
        privateKey: bob.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const carolClient = await createClient({
        privateKey: carol.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });

      clients.push(aliceClient, bobClient, carolClient);

      const bobPublished = await bobClient.PublishKeyPackage({
        keyPackageRef: scenario.bobKeyPackageRef,
        keyPackageBase64: encodeBase64(
          encode(keyPackageEncoder, scenario.bob.keyPackage),
        ),
      });
      const carolPublished = await carolClient.PublishKeyPackage({
        keyPackageRef: scenario.carolKeyPackageRef,
        keyPackageBase64: encodeBase64(
          encode(keyPackageEncoder, scenario.carol.keyPackage),
        ),
      });

      const consumedBob = await aliceClient.ConsumeKeyPackage({
        identifier: bob.actor.stablePubkey,
      });
      const consumedCarol = await aliceClient.ConsumeKeyPackage({
        identifier: carol.actor.stablePubkey,
      });

      expect(consumedBob.keyPackage?.keyPackageRef).toBe(
        bobPublished.keyPackageRef,
      );
      expect(consumedCarol.keyPackage?.keyPackageRef).toBe(
        carolPublished.keyPackageRef,
      );

      await aliceClient.StoreWelcome({
        targetStablePubkey: bob.actor.stablePubkey,
        keyPackageReference: scenario.bobKeyPackageRef,
        welcomeBase64: encodeBase64(
          encode(mlsMessageEncoder, {
            version: protocolVersions.mls10,
            wireformat: wireformats.mls_welcome,
            welcome: scenario.bobWelcome,
          }),
        ),
      });
      await aliceClient.StoreWelcome({
        targetStablePubkey: carol.actor.stablePubkey,
        keyPackageReference: scenario.carolKeyPackageRef,
        welcomeBase64: encodeBase64(
          encode(mlsMessageEncoder, {
            version: protocolVersions.mls10,
            wireformat: wireformats.mls_welcome,
            welcome: scenario.carolWelcome,
          }),
        ),
      });

      const bobWelcomes = await bobClient.FetchPendingWelcomes({});
      const carolWelcomes = await carolClient.FetchPendingWelcomes({});

      expect(bobWelcomes.welcomes).toHaveLength(1);
      expect(carolWelcomes.welcomes).toHaveLength(1);
      expect(bobWelcomes.welcomes[0]?.keyPackageReference).toBe(
        scenario.bobKeyPackageRef,
      );
      expect(carolWelcomes.welcomes[0]?.keyPackageReference).toBe(
        scenario.carolKeyPackageRef,
      );
      expect((await bobClient.FetchPendingWelcomes({})).welcomes).toEqual([]);
      expect((await carolClient.FetchPendingWelcomes({})).welcomes).toEqual([]);

      const postedCommit = await aliceClient.PostGroupMessage({
        opaqueMessageBase64: encodeBase64(scenario.commitMessageBytes),
      });
      const postedAliceMessage = await aliceClient.PostGroupMessage({
        opaqueMessageBase64: encodeBase64(scenario.aliceApplicationBytes),
      });
      const postedBobMessage = await bobClient.PostGroupMessage({
        opaqueMessageBase64: encodeBase64(scenario.bobApplicationBytes),
      });

      const allMessages = await aliceClient.FetchGroupMessages({
        groupId: postedCommit.groupId,
      });
      const newerMessages = await aliceClient.FetchGroupMessages({
        groupId: postedCommit.groupId,
        afterCursor: postedCommit.cursor,
      });

      expect(allMessages.messages).toHaveLength(3);
      expect(newerMessages.messages).toHaveLength(2);
      expect(newerMessages.messages[0]?.cursor).toBe(postedAliceMessage.cursor);
      expect(newerMessages.messages[1]?.cursor).toBe(postedBobMessage.cursor);

      expect(server.coordinator.snapshot()).toEqual({
        stableIdentities: 0,
        publishedKeyPackages: 0,
        pendingWelcomes: 0,
        trackedGroups: 1,
        queuedMessages: 3,
      });
    } finally {
      await server.transport.close();
    }
  });

  test("round-trips queued application messages through the real ContextVM interface", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const scenario = await createThreeActorGroupScenario();

      const aliceClient = await createClient({
        privateKey: scenario.alice.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bobClient = await createClient({
        privateKey: scenario.bob.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const carolClient = await createClient({
        privateKey: scenario.carol.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });

      clients.push(aliceClient, bobClient, carolClient);

      const posted = await aliceClient.PostGroupMessage({
        opaqueMessageBase64: encodeBase64(scenario.aliceApplicationBytes),
      });
      const fetched = await bobClient.FetchGroupMessages({
        groupId: posted.groupId,
      });
      const [message] = fetched.messages;

      expect(message?.cursor).toBe(posted.cursor);

      const bobResult = await processMessageBytes({
        state: scenario.bob.state,
        encodedMessage: decodeBase64(message!.opaqueMessageBase64),
      });
      const carolResult = await processMessageBytes({
        state: scenario.carol.state,
        encodedMessage: decodeBase64(message!.opaqueMessageBase64),
      });

      expect(bobResult.kind).toBe("applicationMessage");
      expect(carolResult.kind).toBe("applicationMessage");
      if (
        bobResult.kind !== "applicationMessage" ||
        carolResult.kind !== "applicationMessage"
      ) {
        throw new Error("Expected application message results");
      }

      expect(new TextDecoder().decode(bobResult.message)).toBe(
        "hello from alice",
      );
      expect(new TextDecoder().decode(carolResult.message)).toBe(
        "hello from alice",
      );
    } finally {
      await server.transport.close();
    }
  });

  test("preserves ordered queue semantics across proposal, commit, and application traffic through the real ContextVM interface", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const scenario = await createThreeActorGroupScenario();
      const cipherSuite = await getTestCiphersuite();
      const bobClient = await createClient({
        privateKey: scenario.bob.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const aliceClient = await createClient({
        privateKey: scenario.alice.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });

      clients.push(aliceClient, bobClient);

      const proposal = await createProposalMessageBytes({
        state: scenario.alice.state,
        proposal: {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: 2 },
        },
        wireAsPublicMessage: true,
      });
      const postedProposal = await aliceClient.PostGroupMessage({
        opaqueMessageBase64: encodeBase64(proposal.encodedMessage),
      });

      const commit = await createCommitMessageBytes({
        state: proposal.newState,
      });
      const postedCommit = await aliceClient.PostGroupMessage({
        opaqueMessageBase64: encodeBase64(commit.encodedMessage),
      });

      const application = await createApplicationMessageBytes({
        state: commit.newState,
        plaintext: "ordered traffic",
      });
      const postedApplication = await bobClient.PostGroupMessage({
        opaqueMessageBase64: encodeBase64(application.encodedMessage),
      });

      const queued = await bobClient.FetchGroupMessages({
        groupId: postedProposal.groupId,
      });
      expect(queued.messages.map((message) => message.cursor)).toEqual([
        postedProposal.cursor,
        postedCommit.cursor,
        postedApplication.cursor,
      ]);

      const bobProposalResult = await processMessage({
        context: {
          cipherSuite,
          authService: unsafeTestingAuthenticationService,
        },
        state: scenario.bob.state,
        message: decodeMlsFramedMessage(
          decodeBase64(queued.messages[0]!.opaqueMessageBase64),
        ),
      });
      expect(bobProposalResult.kind).toBe("newState");
      if (bobProposalResult.kind !== "newState") {
        throw new Error("Expected public proposal to update state");
      }

      const bobCommitResult = await processMessage({
        context: {
          cipherSuite,
          authService: unsafeTestingAuthenticationService,
        },
        state: bobProposalResult.newState,
        message: decodeMlsFramedMessage(
          decodeBase64(queued.messages[1]!.opaqueMessageBase64),
        ),
      });
      expect(bobCommitResult.kind).toBe("newState");
      if (bobCommitResult.kind !== "newState") {
        throw new Error("Expected commit to update state");
      }

      const bobApplicationResult = await processMessage({
        context: {
          cipherSuite,
          authService: unsafeTestingAuthenticationService,
        },
        state: bobCommitResult.newState,
        message: decodeMlsFramedMessage(
          decodeBase64(queued.messages[2]!.opaqueMessageBase64),
        ),
      });
      expect(bobApplicationResult.kind).toBe("applicationMessage");
      if (bobApplicationResult.kind !== "applicationMessage") {
        throw new Error("Expected ordered application delivery");
      }

      expect(new TextDecoder().decode(bobApplicationResult.message)).toBe(
        "ordered traffic",
      );
    } finally {
      await server.transport.close();
    }
  });
});
