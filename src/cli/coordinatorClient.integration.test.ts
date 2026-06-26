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
  createActor,
  createApplicationMessageBytes,
  createCommitMessageBytes,
  createKeyPackageRef,
  createMemberArtifacts,
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
      // Non-destructive fetch: welcomes survive subsequent reads.
      expect((await bobClient.FetchPendingWelcomes({})).welcomes).toHaveLength(
        1,
      );
      expect(
        (await carolClient.FetchPendingWelcomes({})).welcomes,
      ).toHaveLength(1);

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
      const manyMessages = await aliceClient.FetchManyGroupMessages({
        groups: [{ gid: postedCommit.gid, after: postedCommit.cursor }],
      });

      expect(allMessages.messages).toHaveLength(3);
      expect(newerMessages.messages).toHaveLength(2);
      expect(manyMessages.messages).toEqual(newerMessages.messages);
      expect(newerMessages.messages[0]?.cursor).toBe(postedAliceMessage.cursor);
      expect(newerMessages.messages[1]?.cursor).toBe(postedBobMessage.cursor);
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

  // Regression probe for the reported "join request stored but admin never
  // receives it" symptom. StoreJoinRequest rides the STABLE transport and
  // FetchManyPendingJoinRequests rides the EPHEMERAL transport, so this test
  // exercises the exact cross-transport split the web client uses. The gid is
  // an opaque string the coordinator does not validate (spec §9.4), which
  // mimics a freshly created group that has no posted messages yet.
  //
  // If this test PASSES, the server/routing/transport-split is exonerated for
  // the healthy-relay case and the defect must live in the web application
  // layer (e.g. coordinator-key mismatch between requester share link and
  // admin group record) or in production relay health. If it FAILS, this is a
  // deterministic reproduction of the bug.
  test("delivers a join request stored via stable transport to a batch fetch via ephemeral transport", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const requester = await createMemberArtifacts(createActor("requester"));
      const requesterKeyPackageRef = await createKeyPackageRef(
        requester.keyPackage,
      );
      // Opaque MLS-style group id; coordinator does not validate existence.
      const gid = "550e8400-e29b-41d4-a716-446655440000";

      const requesterClient = await createClient({
        privateKey: requester.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const adminClient = await createClient({
        privateKey: createActor("admin").secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      clients.push(requesterClient, adminClient);

      // Requester publishes a key package, then stores a join request.
      // StoreJoinRequest requires the caller to own the key package and rides
      // the STABLE transport, so the requester's stable pubkey is injected.
      await requesterClient.PublishKeyPackage({
        kp_ref: requesterKeyPackageRef,
        kp_64: encodeBase64(encode(keyPackageEncoder, requester.keyPackage)),
      });
      await requesterClient.StoreJoinRequest({
        gid,
        kp_ref: requesterKeyPackageRef,
      });

      // An unrelated admin fetches pending join requests for the group via the
      // batch method, which rides the EPHEMERAL transport.
      const result = await adminClient.FetchManyPendingJoinRequests({
        groups: [{ gid }],
      });

      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]?.gid).toBe(gid);
      expect(result.requests[0]?.pk).toBe(requester.actor.stablePubkey);
      expect(result.requests[0]?.kp_ref).toBe(requesterKeyPackageRef);
    } finally {
      await server.transport.close();
    }
  });

  // Probe for the leading hypothesis behind "join request stored but admin
  // never receives it, even after polling/refresh": a COORDINATOR MISMATCH.
  // The web requester resolves their target coordinator from the share link's
  // `?c=` param with a silent fallback to DEFAULT when `c` is absent, while the
  // admin always fetches from the coordinator recorded on their group record.
  // If those two coordinators differ, the request is stored on server A but the
  // admin polls server B forever — both calls succeed, no error is surfaced,
  // and a page refresh cannot help because the request simply is not on B.
  //
  // This test stands up TWO independent coordinator servers on the shared mock
  // relay and reproduces that exact split: requester stores to coordinator A
  // (the DEFAULT fallback), the group actually lives on coordinator B. The
  // admin's batch fetch against B returns empty, while the same request is
  // sitting on A.
  test("a join request stored on the wrong coordinator is invisible to the admin's fetch and survives a fresh client", async () => {
    const relayHub = new MockRelayHub();

    // Coordinator A: the coordinator the requester silently falls back to.
    const serverASigner = new PrivateKeySigner();
    const serverAPubkey = await serverASigner.getPublicKey();
    const serverA = await connectServer({
      signer: serverASigner,
      relayHandler: relayHub.createRelayHandler(),
    });
    // Coordinator B: the coordinator the group actually lives on (admin's record).
    const serverBSigner = new PrivateKeySigner();
    const serverBPubkey = await serverBSigner.getPublicKey();
    const serverB = await connectServer({
      signer: serverBSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const requester = await createMemberArtifacts(createActor("requester"));
      const requesterKeyPackageRef = await createKeyPackageRef(
        requester.keyPackage,
      );
      const gid = "550e8400-e29b-41d4-a716-446655440000";

      // Requester resolves coordinatorKey = A (e.g. stripped share link → DEFAULT).
      const requesterClient = await createClient({
        privateKey: requester.actor.secretKey,
        serverPubkey: serverAPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      clients.push(requesterClient);

      await requesterClient.PublishKeyPackage({
        kp_ref: requesterKeyPackageRef,
        kp_64: encodeBase64(encode(keyPackageEncoder, requester.keyPackage)),
      });
      // Store succeeds on A — the requester sees "Join request sent".
      await requesterClient.StoreJoinRequest({
        gid,
        kp_ref: requesterKeyPackageRef,
      });

      // Admin's group record says the group is on B, so the admin fetches from B.
      const adminFetchFromGroupCoordinator = async (): Promise<
        Awaited<ReturnType<cordnClient["FetchManyPendingJoinRequests"]>>
      > => {
        const adminClient = await createClient({
          privateKey: createActor("admin").secretKey,
          serverPubkey: serverBPubkey,
          relayHandler: relayHub.createRelayHandler(),
        });
        clients.push(adminClient);
        return adminClient.FetchManyPendingJoinRequests({ groups: [{ gid }] });
      };

      // First poll.
      expect((await adminFetchFromGroupCoordinator()).requests).toEqual([]);
      // "Page refresh": a brand-new client/coordinator session polling B again.
      expect((await adminFetchFromGroupCoordinator()).requests).toEqual([]);

      // The request was never lost — it is sitting on coordinator A, which the
      // admin never queries. Fetching A surfaces it immediately.
      const adminClientOnA = await createClient({
        privateKey: createActor("admin").secretKey,
        serverPubkey: serverAPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      clients.push(adminClientOnA);
      const fromA = await adminClientOnA.FetchManyPendingJoinRequests({
        groups: [{ gid }],
      });
      expect(fromA.requests).toHaveLength(1);
      expect(fromA.requests[0]?.pk).toBe(requester.actor.stablePubkey);
    } finally {
      await serverA.transport.close();
      await serverB.transport.close();
    }
  });
});
