import { describe, expect, test } from "vitest";
import {
  defaultProposalTypes,
  processMessage,
  unsafeTestingAuthenticationService,
} from "ts-mls";

import { DeliveryServiceCoordinator } from "./deliveryServiceCoordinator";
import {
  createActor,
  createApplicationMessageBytes,
  createCommitMessageBytes,
  createEphemeralPubkey,
  createMemberArtifacts,
  createProposalMessageBytes,
  createThreeActorGroupScenario,
  decodeMlsFramedMessage,
  getTestCiphersuite,
  processMessageBytes,
} from "./testUtils";

describe("DeliveryServiceCoordinator integration flow", () => {
  test("supports an alice, bob, and carol invitation and delivery scenario", async () => {
    const coordinator = new DeliveryServiceCoordinator();
    const scenario = await createThreeActorGroupScenario();
    const { alice, bob, carol } = scenario;

    expect(alice.actor.stablePubkey).not.toBe(bob.actor.stablePubkey);
    expect(bob.actor.stablePubkey).not.toBe(carol.actor.stablePubkey);

    const bobKeyPackage = coordinator.publishKeyPackage({
      stablePubkey: bob.actor.stablePubkey,
      keyPackage: scenario.bob.keyPackage,
      keyPackageRef: scenario.bobKeyPackageRef,
    });

    const carolKeyPackage = coordinator.publishKeyPackage({
      stablePubkey: carol.actor.stablePubkey,
      keyPackage: scenario.carol.keyPackage,
      keyPackageRef: scenario.carolKeyPackageRef,
    });

    expect(
      coordinator.listKeyPackagesForIdentity(bob.actor.stablePubkey),
    ).toHaveLength(1);
    expect(
      coordinator.listKeyPackagesForIdentity(carol.actor.stablePubkey),
    ).toHaveLength(1);

    expect(
      coordinator.consumeKeyPackageForIdentity(bob.actor.stablePubkey)?.id,
    ).toBe(bobKeyPackage.id);
    expect(
      coordinator.consumeKeyPackageForIdentity(carol.actor.stablePubkey)?.id,
    ).toBe(carolKeyPackage.id);

    coordinator.storeWelcome({
      targetStablePubkey: bob.actor.stablePubkey,
      keyPackageReference: bobKeyPackage.keyPackageRef,
      welcome: scenario.bobWelcome,
    });

    coordinator.storeWelcome({
      targetStablePubkey: carol.actor.stablePubkey,
      keyPackageReference: carolKeyPackage.keyPackageRef,
      welcome: scenario.carolWelcome,
    });

    const bobWelcomes = coordinator.fetchPendingWelcomes(
      bob.actor.stablePubkey,
    );
    const carolWelcomes = coordinator.fetchPendingWelcomes(
      carol.actor.stablePubkey,
    );

    expect(bobWelcomes).toHaveLength(1);
    expect(carolWelcomes).toHaveLength(1);
    expect(coordinator.fetchPendingWelcomes(bob.actor.stablePubkey)).toEqual(
      [],
    );
    expect(coordinator.fetchPendingWelcomes(carol.actor.stablePubkey)).toEqual(
      [],
    );

    const commitMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: createEphemeralPubkey(),
      opaqueMessage: scenario.commitMessageBytes,
    });

    const aliceApplicationMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: createEphemeralPubkey(),
      opaqueMessage: scenario.aliceApplicationBytes,
    });

    const bobApplicationMessage = coordinator.postGroupMessage({
      ephemeralSenderPubkey: createEphemeralPubkey(),
      opaqueMessage: scenario.bobApplicationBytes,
    });

    const groupId = commitMessage.groupId;

    const allMessages = coordinator.fetchGroupMessages({ groupId });
    const newerMessages = coordinator.fetchGroupMessages({
      groupId,
      afterCursor: commitMessage.cursor,
    });

    expect(allMessages).toHaveLength(3);
    expect(newerMessages).toHaveLength(2);
    expect(newerMessages[0]?.cursor).toBe(aliceApplicationMessage.cursor);
    expect(newerMessages[1]?.cursor).toBe(bobApplicationMessage.cursor);

    expect(coordinator.getGroupRouting(groupId)).toEqual({
      groupId,
      latestHandshakeEpoch: 1n,
      lastMessageCursor: bobApplicationMessage.cursor,
    });

    expect(() =>
      coordinator.postGroupMessage({
        ephemeralSenderPubkey: createEphemeralPubkey(),
        opaqueMessage: scenario.commitMessageBytes.slice(
          0,
          scenario.commitMessageBytes.length - 1,
        ),
      }),
    ).toThrow();

    expect(coordinator.snapshot()).toEqual({
      stableIdentities: 0,
      publishedKeyPackages: 0,
      pendingWelcomes: 0,
      trackedGroups: 1,
      queuedMessages: 3,
    });
  });

  test("round-trips queued application messages through coordinator fetch and MLS processing", async () => {
    const coordinator = new DeliveryServiceCoordinator();
    const scenario = await createThreeActorGroupScenario();

    const posted = coordinator.postGroupMessage({
      ephemeralSenderPubkey: createEphemeralPubkey(),
      opaqueMessage: scenario.aliceApplicationBytes,
    });

    const [fetched] = coordinator.fetchGroupMessages({
      groupId: posted.groupId,
    });
    expect(fetched?.cursor).toBe(posted.cursor);

    const bobResult = await processMessageBytes({
      state: scenario.bob.state,
      encodedMessage: fetched!.opaqueMessage,
    });
    const carolResult = await processMessageBytes({
      state: scenario.carol.state,
      encodedMessage: fetched!.opaqueMessage,
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
  });

  test("supports commit propagation and post-commit state convergence through the coordinator", async () => {
    const coordinator = new DeliveryServiceCoordinator();
    const scenario = await createThreeActorGroupScenario();

    const extraMember = await createMemberArtifacts(createActor("dave"));
    const commit = await createCommitMessageBytes({
      state: scenario.alice.state,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: extraMember.keyPackage },
        },
      ],
    });

    const postedCommit = coordinator.postGroupMessage({
      ephemeralSenderPubkey: createEphemeralPubkey(),
      opaqueMessage: commit.encodedMessage,
    });

    const [queuedCommit] = coordinator.fetchGroupMessages({
      groupId: postedCommit.groupId,
    });
    const bobCommitResult = await processMessageBytes({
      state: scenario.bob.state,
      encodedMessage: queuedCommit!.opaqueMessage,
    });
    const carolCommitResult = await processMessageBytes({
      state: scenario.carol.state,
      encodedMessage: queuedCommit!.opaqueMessage,
    });

    expect(bobCommitResult.kind).toBe("newState");
    expect(carolCommitResult.kind).toBe("newState");
    if (
      bobCommitResult.kind !== "newState" ||
      carolCommitResult.kind !== "newState"
    ) {
      throw new Error("Expected commit processing to advance member state");
    }

    const application = await createApplicationMessageBytes({
      state: bobCommitResult.newState,
      plaintext: "post-commit hello from bob",
    });

    const postedApplication = coordinator.postGroupMessage({
      ephemeralSenderPubkey: createEphemeralPubkey(),
      opaqueMessage: application.encodedMessage,
    });

    const queuedApplications = coordinator.fetchGroupMessages({
      groupId: postedApplication.groupId,
      afterCursor: postedCommit.cursor,
    });

    const aliceApplicationResult = await processMessageBytes({
      state: commit.newState,
      encodedMessage: queuedApplications[0]!.opaqueMessage,
    });
    const carolApplicationResult = await processMessageBytes({
      state: carolCommitResult.newState,
      encodedMessage: queuedApplications[0]!.opaqueMessage,
    });

    expect(aliceApplicationResult.kind).toBe("applicationMessage");
    expect(carolApplicationResult.kind).toBe("applicationMessage");
    if (
      aliceApplicationResult.kind !== "applicationMessage" ||
      carolApplicationResult.kind !== "applicationMessage"
    ) {
      throw new Error("Expected application message after commit convergence");
    }

    expect(new TextDecoder().decode(aliceApplicationResult.message)).toBe(
      "post-commit hello from bob",
    );
    expect(new TextDecoder().decode(carolApplicationResult.message)).toBe(
      "post-commit hello from bob",
    );
  });

  test("preserves ordered queue semantics across proposal, commit, and application traffic", async () => {
    const coordinator = new DeliveryServiceCoordinator();
    const scenario = await createThreeActorGroupScenario();
    const cipherSuite = await getTestCiphersuite();

    const proposal = await createProposalMessageBytes({
      state: scenario.alice.state,
      proposal: {
        proposalType: defaultProposalTypes.remove,
        remove: { removed: 2 },
      },
      wireAsPublicMessage: true,
    });

    const postedProposal = coordinator.postGroupMessage({
      ephemeralSenderPubkey: createEphemeralPubkey(),
      opaqueMessage: proposal.encodedMessage,
    });

    const commit = await createCommitMessageBytes({
      state: proposal.newState,
    });
    const postedCommit = coordinator.postGroupMessage({
      ephemeralSenderPubkey: createEphemeralPubkey(),
      opaqueMessage: commit.encodedMessage,
    });

    const application = await createApplicationMessageBytes({
      state: commit.newState,
      plaintext: "ordered traffic",
    });
    const postedApplication = coordinator.postGroupMessage({
      ephemeralSenderPubkey: createEphemeralPubkey(),
      opaqueMessage: application.encodedMessage,
    });

    const queued = coordinator.fetchGroupMessages({
      groupId: postedProposal.groupId,
    });
    expect(queued.map((message) => message.cursor)).toEqual([
      postedProposal.cursor,
      postedCommit.cursor,
      postedApplication.cursor,
    ]);

    const bobProposalResult = await processMessage({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      state: scenario.bob.state,
      message: decodeMlsFramedMessage(queued[0]!.opaqueMessage),
    });
    expect(bobProposalResult.kind).toBe("newState");
    if (bobProposalResult.kind !== "newState") {
      throw new Error("Expected public proposal to update state");
    }

    const bobCommitResult = await processMessage({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      state: bobProposalResult.newState,
      message: decodeMlsFramedMessage(queued[1]!.opaqueMessage),
    });
    expect(bobCommitResult.kind).toBe("newState");
    if (bobCommitResult.kind !== "newState") {
      throw new Error("Expected commit to update state");
    }

    const bobApplicationResult = await processMessage({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      state: bobCommitResult.newState,
      message: decodeMlsFramedMessage(queued[2]!.opaqueMessage),
    });
    expect(bobApplicationResult.kind).toBe("applicationMessage");
    if (bobApplicationResult.kind !== "applicationMessage") {
      throw new Error("Expected ordered application delivery");
    }

    expect(new TextDecoder().decode(bobApplicationResult.message)).toBe(
      "ordered traffic",
    );
  });
});
