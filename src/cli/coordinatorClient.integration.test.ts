import { afterEach, describe, expect, test } from "vitest";
import {
  createUnsignedCordnMessageEvent,
  decodeCordnMessageEvent,
  finalizeCordnMessageEvent,
} from "./messageEnvelope.ts";
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
  createKeyPackageRef,
  createProposalMessageBytes,
  createThreeActorGroupScenario,
  decodeMlsFramedMessage,
  getTestCiphersuite,
  processMessageBytes,
} from "../coordinator/testUtils.ts";
import {
  EncryptionMode,
  PrivateKeySigner,
  type RelayHandler,
} from "@contextvm/sdk";
import { verifyEvent } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { decodeBase64, encodeBase64 } from "../server/base64.ts";
import { cordnClient } from "./coordinatorClient.ts";

async function createClient(params: {
  privateKey: Uint8Array;
  ephemeralPrivateKey?: string;
  serverPubkey: string;
  relayHandler: RelayHandler;
}): Promise<cordnClient> {
  return new cordnClient({
    privateKey: bytesToHex(params.privateKey),
    ephemeralPrivateKey: params.ephemeralPrivateKey,
    encryptionMode: EncryptionMode.DISABLED,
    serverPubkey: params.serverPubkey,
    relayHandler: params.relayHandler,
  });
}

function getVerifiedClientPubkeys(
  events: ReturnType<MockRelayHub["getEvents"]>,
  serverPubkey: string,
): string[] {
  return [
    ...new Set(
      events
        .filter((event) => verifyEvent(event) && event.pubkey !== serverPubkey)
        .map((event) => event.pubkey),
    ),
  ];
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
        kp_ref: scenario.bobKeyPackageRef,
        kp_64: encodeBase64(encode(keyPackageEncoder, scenario.bob.keyPackage)),
      });
      const carolPublished = await carolClient.PublishKeyPackage({
        kp_ref: scenario.carolKeyPackageRef,
        kp_64: encodeBase64(
          encode(keyPackageEncoder, scenario.carol.keyPackage),
        ),
      });

      const consumedBob = await aliceClient.ConsumeKeyPackage({
        id: bob.actor.stablePubkey,
      });
      const consumedCarol = await aliceClient.ConsumeKeyPackage({
        id: carol.actor.stablePubkey,
      });

      expect(consumedBob.keyPackage?.kp_ref).toBe(bobPublished.kp_ref);
      expect(consumedCarol.keyPackage?.kp_ref).toBe(carolPublished.kp_ref);

      await aliceClient.StoreWelcome({
        target_pk: bob.actor.stablePubkey,
        kp_ref: scenario.bobKeyPackageRef,
        welcome_64: encodeBase64(
          encode(mlsMessageEncoder, {
            version: protocolVersions.mls10,
            wireformat: wireformats.mls_welcome,
            welcome: scenario.bobWelcome,
          }),
        ),
      });
      await aliceClient.StoreWelcome({
        target_pk: carol.actor.stablePubkey,
        kp_ref: scenario.carolKeyPackageRef,
        welcome_64: encodeBase64(
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
      expect(bobWelcomes.welcomes[0]?.kp_ref).toBe(scenario.bobKeyPackageRef);
      expect(carolWelcomes.welcomes[0]?.kp_ref).toBe(
        scenario.carolKeyPackageRef,
      );
      expect((await bobClient.FetchPendingWelcomes({})).welcomes).toEqual([]);
      expect((await carolClient.FetchPendingWelcomes({})).welcomes).toEqual([]);

      const postedCommit = await aliceClient.PostGroupMessage({
        msg_64: encodeBase64(scenario.commitMessageBytes),
      });
      const postedAliceMessage = await aliceClient.PostGroupMessage({
        msg_64: encodeBase64(scenario.aliceApplicationBytes),
      });
      const postedBobMessage = await bobClient.PostGroupMessage({
        msg_64: encodeBase64(scenario.bobApplicationBytes),
      });

      const allMessages = await aliceClient.FetchGroupMessages({
        gid: postedCommit.gid,
      });
      const newerMessages = await aliceClient.FetchGroupMessages({
        gid: postedCommit.gid,
        after: postedCommit.cursor,
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

  test("routes stable and ephemeral coordinator methods through the expected pubkeys", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const scenario = await createThreeActorGroupScenario();
      const ephemeralPrivateKey =
        "1111111111111111111111111111111111111111111111111111111111111111";
      const ephemeralPubkey = await new PrivateKeySigner(
        ephemeralPrivateKey,
      ).getPublicKey();
      const stablePubkey = scenario.alice.actor.stablePubkey;
      const stableKeyPackageRef = await createKeyPackageRef(
        scenario.alice.keyPackage,
      );

      const aliceClient = await createClient({
        privateKey: scenario.alice.actor.secretKey,
        ephemeralPrivateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });

      clients.push(aliceClient);

      let start = relayHub.getEvents().length;
      await aliceClient.PublishKeyPackage({
        kp_ref: stableKeyPackageRef,
        kp_64: encodeBase64(
          encode(keyPackageEncoder, scenario.alice.keyPackage),
        ),
      });
      expect(
        getVerifiedClientPubkeys(
          relayHub.getEvents().slice(start),
          serverPubkey,
        ),
      ).toContain(stablePubkey);

      start = relayHub.getEvents().length;
      await aliceClient.FetchPendingWelcomes({});
      expect(
        getVerifiedClientPubkeys(
          relayHub.getEvents().slice(start),
          serverPubkey,
        ),
      ).toContain(stablePubkey);

      start = relayHub.getEvents().length;
      await aliceClient.RemoveKeyPackages({
        kp_refs: [stableKeyPackageRef],
      });
      expect(
        getVerifiedClientPubkeys(
          relayHub.getEvents().slice(start),
          serverPubkey,
        ),
      ).toContain(stablePubkey);

      start = relayHub.getEvents().length;
      await aliceClient.PostGroupMessage({
        msg_64: encodeBase64(scenario.aliceApplicationBytes),
      });
      expect(
        getVerifiedClientPubkeys(
          relayHub.getEvents().slice(start),
          serverPubkey,
        ),
      ).toContain(ephemeralPubkey);

      const posted = await aliceClient.PostGroupMessage({
        msg_64: encodeBase64(scenario.aliceApplicationBytes),
      });

      start = relayHub.getEvents().length;
      await aliceClient.FetchGroupMessages({ gid: posted.gid });
      expect(
        getVerifiedClientPubkeys(
          relayHub.getEvents().slice(start),
          serverPubkey,
        ),
      ).toContain(ephemeralPubkey);

      start = relayHub.getEvents().length;
      await aliceClient.StoreWelcome({
        target_pk: stablePubkey,
        kp_ref: stableKeyPackageRef,
        welcome_64: encodeBase64(
          encode(mlsMessageEncoder, {
            version: protocolVersions.mls10,
            wireformat: wireformats.mls_welcome,
            welcome: scenario.bobWelcome,
          }),
        ),
      });
      expect(
        getVerifiedClientPubkeys(
          relayHub.getEvents().slice(start),
          serverPubkey,
        ),
      ).toContain(ephemeralPubkey);
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
        msg_64: encodeBase64(scenario.aliceApplicationBytes),
      });
      const fetched = await bobClient.FetchGroupMessages({
        gid: posted.gid,
      });
      const [message] = fetched.messages;

      expect(message?.cursor).toBe(posted.cursor);

      const bobResult = await processMessageBytes({
        state: scenario.bob.state,
        encodedMessage: decodeBase64(message!.msg_64),
      });
      const carolResult = await processMessageBytes({
        state: scenario.carol.state,
        encodedMessage: decodeBase64(message!.msg_64),
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
        msg_64: encodeBase64(proposal.encodedMessage),
      });

      const commit = await createCommitMessageBytes({
        state: proposal.newState,
      });
      const postedCommit = await aliceClient.PostGroupMessage({
        msg_64: encodeBase64(commit.encodedMessage),
      });

      const orderedTrafficEvent = finalizeCordnMessageEvent(
        createUnsignedCordnMessageEvent({
          pubkey: scenario.bob.actor.stablePubkey,
          content: "ordered traffic",
          createdAt: 1,
        }),
      );
      const application = await createApplicationMessageBytes({
        state: commit.newState,
        plaintext: JSON.stringify(orderedTrafficEvent),
      });
      const postedApplication = await bobClient.PostGroupMessage({
        msg_64: encodeBase64(application.encodedMessage),
      });

      const queued = await bobClient.FetchGroupMessages({
        gid: postedProposal.gid,
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
          decodeBase64(queued.messages[0]!.msg_64),
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
          decodeBase64(queued.messages[1]!.msg_64),
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
          decodeBase64(queued.messages[2]!.msg_64),
        ),
      });
      expect(bobApplicationResult.kind).toBe("applicationMessage");
      if (bobApplicationResult.kind !== "applicationMessage") {
        throw new Error("Expected ordered application delivery");
      }

      expect(
        decodeCordnMessageEvent(bobApplicationResult.message).content,
      ).toBe("ordered traffic");
    } finally {
      await server.transport.close();
    }
  });
});
