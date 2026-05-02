import { afterEach, describe, expect, test } from "vitest";

import { CliSession } from "./session.ts";
import { NoPublishedKeyPackageError } from "./sessionErrors.ts";
import { connectServer } from "../server/coordinatorServer.ts";
import { MockRelayHub } from "../test/mockRelay.ts";
import { PrivateKeySigner } from "@contextvm/sdk";

describe("CliSession", () => {
  const sessions: CliSession[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      sessions.splice(0).map((session) => session.disconnect()),
    );
  });

  test("creates key packages, invites a member, accepts the welcome, and exchanges chat messages", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-main");
      await bob.publishKeyPackage("bob-main");

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const invitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(invitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "hello bob");
      const synced = await bob.syncGroup("demo");

      expect(synced).toHaveLength(1);
      expect(synced[0]?.plaintext).toBe("hello bob");
      expect(synced[0]?.sender).toBe(alice.stablePubkey);

      await bob.sendMessage("demo", "hello alice");
      const aliceSynced = await alice.syncGroup("demo");

      expect(aliceSynced).toHaveLength(1);
      expect(aliceSynced[0]?.plaintext).toBe("hello alice");
      expect(aliceSynced[0]?.sender).toBe(bob.stablePubkey);
    } finally {
      await server.transport.close();
    }
  });

  test("does not skip unseen coordinator messages after multiple local sends without intermediate sync", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-main");
      await bob.publishKeyPackage("bob-main");

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const invitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(invitation.keyPackageReference, "demo");

      await bob.sendMessage("demo", "bob-1");
      await alice.syncGroup("demo");

      await alice.sendMessage("demo", "alice-1");
      await alice.sendMessage("demo", "alice-2");
      await alice.sendMessage("demo", "alice-3");

      const bobReceived = await bob.syncGroup("demo");

      expect(bobReceived.map((message) => message.plaintext)).toEqual([
        "alice-1",
        "alice-2",
        "alice-3",
      ]);
      expect(
        bob
          .listMessages("demo")
          .filter((message) => message.direction === "inbound")
          .map((message) => message.plaintext),
      ).toEqual(["alice-1", "alice-2", "alice-3"]);
    } finally {
      await server.transport.close();
    }
  });

  test("allows inviting by exact published key package ref", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-old");
      await bob.generateKeyPackage("bob-new");
      await bob.publishKeyPackage("bob-old");
      const published = await bob.publishKeyPackage("bob-new");

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const invitation = await alice.addMember("demo", published.keyPackageRef);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(invitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "hello exact key package");
      const synced = await bob.syncGroup("demo");

      expect(invitation.keyPackageReference).toBe(published.keyPackageRef);
      expect(synced).toHaveLength(1);
      expect(synced[0]?.plaintext).toBe("hello exact key package");
    } finally {
      await server.transport.close();
    }
  });

  test("creates groups with shared metadata carried in MLS state", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-main");
      await bob.publishKeyPackage("bob-main");

      const created = await alice.createGroup("demo", {
        keyPackageAlias: "alice-main",
        metadata: {
          name: "Demo Group",
          description: "Shared metadata",
          icon: "🧵",
          imageUrl: "https://example.com/demo.png",
        },
      });

      expect(created.metadata).toEqual({
        name: "Demo Group",
        description: "Shared metadata",
        icon: "🧵",
        imageUrl: "https://example.com/demo.png",
      });

      const invitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");
      await bob.fetchWelcomes();
      const joined = await bob.acceptWelcome(
        invitation.keyPackageReference,
        "demo",
      );

      expect(joined.metadata).toEqual({
        name: "Demo Group",
        description: "Shared metadata",
        icon: "🧵",
        imageUrl: "https://example.com/demo.png",
      });
    } finally {
      await server.transport.close();
    }
  });

  test("uses distinct coordinator group ids even when local aliases are reused", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const carol = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob, carol);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-main");
      await carol.generateKeyPackage("carol-main");
      await bob.publishKeyPackage("bob-main");
      await carol.publishKeyPackage("carol-main");

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "hello bob");
      await bob.syncGroup("demo");

      await alice.createGroup("demo-2", {
        keyPackageAlias: "alice-main",
      });
      const carolInvitation = await alice.addMember(
        "demo-2",
        carol.stablePubkey,
      );
      await alice.syncGroup("demo-2");

      await carol.fetchWelcomes();
      await carol.acceptWelcome(carolInvitation.keyPackageReference, "demo");

      await alice.sendMessage("demo-2", "hello carol");
      const carolSynced = await carol.syncGroup("demo");

      expect(carolSynced).toHaveLength(1);
      expect(carolSynced[0]?.plaintext).toBe("hello carol");
      expect(carolSynced[0]?.cursor).toBe(2);
      expect(carol.getGroup("demo").lastCursor).toBe(2);
      expect(alice.getGroup("demo").lastCursor).toBe(2);
      expect(alice.getGroup("demo-2").lastCursor).toBe(2);
    } finally {
      await server.transport.close();
    }
  });

  test("exposes simple key package inspection summaries", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-main");
      const published = await bob.publishKeyPackage("bob-main");

      const localSummaries = alice.listKeyPackageSummaries();
      const availableSummaries = await alice.listAvailableKeyPackageSummaries();

      expect(localSummaries).toEqual([
        expect.objectContaining({
          alias: "alice-main",
          stablePubkey: alice.stablePubkey,
          supportsGroupMetadata: true,
          consumed: false,
        }),
      ]);
      expect(availableSummaries).toContainEqual(
        expect.objectContaining({
          stablePubkey: bob.stablePubkey,
          keyPackageRef: published.keyPackageRef,
          supportsGroupMetadata: true,
        }),
      );
    } finally {
      await server.transport.close();
    }
  });

  test("retains complete in-memory history and skips stale self commits during sync", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const carol = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob, carol);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-main");
      await carol.generateKeyPackage("carol-main");
      await bob.publishKeyPackage("bob-main");
      await carol.publishKeyPackage("carol-main");

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "hello bob");
      await bob.syncGroup("demo");
      await bob.sendMessage("demo", "hello alice");
      await alice.syncGroup("demo");

      const carolInvitation = await alice.addMember("demo", carol.stablePubkey);
      const aliceMessagesAfterCommit = await alice.syncGroup("demo");

      expect(aliceMessagesAfterCommit).toEqual([]);
      expect(alice.listSyncIssues("demo")).toEqual([]);

      await carol.fetchWelcomes();
      await carol.acceptWelcome(carolInvitation.keyPackageReference, "demo");

      await carol.sendMessage("demo", "hello everyone");
      const aliceReceived = await alice.syncGroup("demo");
      const bobReceived = await bob.syncGroup("demo");

      expect(aliceReceived.map((message) => message.plaintext)).toEqual([
        "hello everyone",
      ]);
      expect(bobReceived.map((message) => message.plaintext)).toEqual([
        "hello everyone",
      ]);
      expect(aliceReceived[0]?.sender).toBe(carol.stablePubkey);
      expect(bobReceived[0]?.sender).toBe(carol.stablePubkey);
      expect(
        alice.listMessages("demo").map((message) => message.plaintext),
      ).toEqual(["hello bob", "hello alice", "hello everyone"]);
    } finally {
      await server.transport.close();
    }
  });

  test("advances fetch progress when replaying already-recorded outbound messages", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-main");
      await bob.publishKeyPackage("bob-main");

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const invitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(invitation.keyPackageReference, "demo");

      const outbound = await alice.sendMessage("demo", "hello bob");
      const firstSync = await alice.syncGroup("demo");
      const secondSync = await alice.syncGroup("demo");

      expect(firstSync).toEqual([]);
      expect(secondSync).toEqual([]);
      expect(alice.listSyncIssues("demo")).toEqual([]);
      expect(alice.getGroup("demo").fetchCursor).toBe(outbound.cursor);
      expect(alice.getGroup("demo").lastCursor).toBe(outbound.cursor);
    } finally {
      await server.transport.close();
    }
  });

  test("treats same-epoch add-member welcomes as tentative until the client can confirm its branch survived sync", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const carol = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const dave = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob, carol, dave);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-main");
      await carol.generateKeyPackage("carol-main");
      await dave.generateKeyPackage("dave-main");
      await bob.publishKeyPackage("bob-main");
      await carol.publishKeyPackage("carol-main");
      await dave.publishKeyPackage("dave-main");

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

      const carolInvitation = await alice.addMember("demo", carol.stablePubkey);
      const daveInvitation = await bob.addMember("demo", dave.stablePubkey);

      expect(await carol.fetchWelcomes()).toEqual([]);
      expect(await dave.fetchWelcomes()).toEqual([]);

      await alice.syncGroup("demo");
      await bob.syncGroup("demo");

      await carol.fetchWelcomes();
      await dave.fetchWelcomes();

      expect(
        carol.listWelcomes().map((welcome) => welcome.keyPackageReference),
      ).toEqual([carolInvitation.keyPackageReference]);
      expect(dave.listWelcomes()).toEqual([]);

      expect(alice.listSyncIssues("demo")).toEqual([
        expect.objectContaining({
          detail: "Cannot process commit or proposal from former epoch",
        }),
      ]);
      expect(bob.listSyncIssues("demo")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: "Cannot process commit or proposal from former epoch",
          }),
        ]),
      );

      await carol.acceptWelcome(carolInvitation.keyPackageReference, "demo");

      await expect(
        dave.acceptWelcome(daveInvitation.keyPackageReference, "demo"),
      ).rejects.toThrow();

      await alice.sendMessage("demo", "post-conflict hello");
      const bobReceived = await bob.syncGroup("demo");

      expect(bobReceived.map((message) => message.plaintext)).toEqual([
        "post-conflict hello",
      ]);

      expect(carol.listGroups()).toHaveLength(1);
      expect(dave.listGroups()).toEqual([]);
    } finally {
      await server.transport.close();
    }
  });

  test("records stale-epoch sync issues while still advancing fetch progress", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const carol = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const dave = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob, carol, dave);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-main");
      await carol.generateKeyPackage("carol-main");
      await dave.generateKeyPackage("dave-main");
      await bob.publishKeyPackage("bob-main");
      await carol.publishKeyPackage("carol-main");
      await dave.publishKeyPackage("dave-main");

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

      await alice.addMember("demo", carol.stablePubkey);
      await bob.addMember("demo", dave.stablePubkey);

      const aliceBefore = alice.getGroup("demo").fetchCursor;
      await alice.syncGroup("demo");
      const aliceAfterFirst = alice.getGroup("demo").fetchCursor;
      const aliceAfterSecond =
        (await alice.syncGroup("demo"), alice.getGroup("demo").fetchCursor);

      expect(alice.listSyncIssues("demo")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: "Cannot process commit or proposal from former epoch",
          }),
        ]),
      );
      expect(aliceAfterFirst).toBeGreaterThan(aliceBefore);
      expect(aliceAfterSecond).toBe(aliceAfterFirst);
    } finally {
      await server.transport.close();
    }
  });

  test("survives a deterministic multi-actor chaos flow with interleaved messages, competing commits, and delayed reconciliation", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const carol = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const dave = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const erin = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob, carol, dave, erin);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-a");
      await bob.generateKeyPackage("bob-b");
      await carol.generateKeyPackage("carol-a");
      await carol.generateKeyPackage("carol-b");
      await dave.generateKeyPackage("dave-b");
      await erin.generateKeyPackage("erin-a");
      await bob.publishKeyPackage("bob-a");
      await bob.publishKeyPackage("bob-b");
      await carol.publishKeyPackage("carol-a");
      await carol.publishKeyPackage("carol-b");
      await dave.publishKeyPackage("dave-b");
      await erin.publishKeyPackage("erin-a");

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "bootstrap-from-alice");
      await bob.syncGroup("demo");

      const carolInvitation = await alice.addMember("demo", carol.stablePubkey);
      const daveInvitation = await bob.addMember("demo", dave.stablePubkey);

      const concurrentSends = await Promise.all([
        alice.sendMessage("demo", "alice-concurrent-1"),
        bob.sendMessage("demo", "bob-concurrent-1"),
      ]);

      expect(concurrentSends.map((message) => message.plaintext)).toEqual([
        "alice-concurrent-1",
        "bob-concurrent-1",
      ]);

      expect(await carol.fetchWelcomes()).toEqual([]);
      expect(await dave.fetchWelcomes()).toEqual([]);

      const aliceCursorBeforeSync = alice.getGroup("demo").fetchCursor;
      const bobCursorBeforeSync = bob.getGroup("demo").fetchCursor;

      const aliceRoundOne = await alice.syncGroup("demo");
      const bobRoundOne = await bob.syncGroup("demo");

      expect(aliceRoundOne.map((message) => message.plaintext)).toEqual(
        expect.arrayContaining(["bob-concurrent-1"]),
      );
      expect(bobRoundOne.map((message) => message.plaintext)).toEqual(
        expect.arrayContaining(["alice-concurrent-1"]),
      );
      expect(alice.getGroup("demo").fetchCursor).toBeGreaterThan(
        aliceCursorBeforeSync,
      );
      expect(bob.getGroup("demo").fetchCursor).toBeGreaterThan(
        bobCursorBeforeSync,
      );

      await carol.fetchWelcomes();
      await dave.fetchWelcomes();

      const deliveredRefs = [
        ...carol.listWelcomes().map((welcome) => welcome.keyPackageReference),
        ...dave.listWelcomes().map((welcome) => welcome.keyPackageReference),
      ];

      expect(deliveredRefs).toHaveLength(1);
      expect(deliveredRefs).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^(${carolInvitation.keyPackageReference}|${daveInvitation.keyPackageReference})$`,
            ),
          ),
        ]),
      );

      const carolJoined =
        carol
          .listWelcomes()
          .find(
            (welcome) =>
              welcome.keyPackageReference ===
              carolInvitation.keyPackageReference,
          ) !== undefined;

      if (carolJoined) {
        await carol.acceptWelcome(carolInvitation.keyPackageReference, "demo");
        await expect(
          dave.acceptWelcome(daveInvitation.keyPackageReference, "demo"),
        ).rejects.toThrow();
      } else {
        await dave.acceptWelcome(daveInvitation.keyPackageReference, "demo");
        await expect(
          carol.acceptWelcome(carolInvitation.keyPackageReference, "demo"),
        ).rejects.toThrow();
      }

      const survivor = carolJoined ? carol : dave;
      const survivorName = carolJoined ? "carol" : "dave";
      const rejectedName = carolJoined ? "dave" : "carol";
      const rejectedSession = carolJoined ? dave : carol;

      const staleIssueHolders = [alice, bob].filter(
        (session) => session.listSyncIssues("demo").length > 0,
      );

      expect(staleIssueHolders.length).toBeGreaterThanOrEqual(1);
      expect(staleIssueHolders).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stablePubkey: expect.any(String),
          }),
        ]),
      );
      expect([
        ...alice.listSyncIssues("demo"),
        ...bob.listSyncIssues("demo"),
      ]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringMatching(/former epoch|epoch too old/),
          }),
        ]),
      );

      await alice.sendMessage(
        "demo",
        `post-reconcile-from-alice-to-${survivorName}`,
      );
      await bob.sendMessage(
        "demo",
        `post-reconcile-from-bob-to-${survivorName}`,
      );

      const survivorMessages = await survivor.syncGroup("demo");

      expect(survivorMessages.map((message) => message.plaintext)).toEqual([
        `post-reconcile-from-alice-to-${survivorName}`,
        `post-reconcile-from-bob-to-${survivorName}`,
      ]);
      expect(
        survivor.listMessages("demo").map((message) => message.plaintext),
      ).toEqual([
        `post-reconcile-from-alice-to-${survivorName}`,
        `post-reconcile-from-bob-to-${survivorName}`,
      ]);

      await alice.syncGroup("demo");

      const aliceHistory = alice.listMessages("demo");
      expect(aliceHistory.map((message) => message.cursor)).toEqual(
        [...aliceHistory.map((message) => message.cursor)].sort(
          (a, b) => a - b,
        ),
      );
      expect(aliceHistory.map((message) => message.plaintext)).toEqual(
        expect.arrayContaining([
          "bootstrap-from-alice",
          `post-reconcile-from-alice-to-${survivorName}`,
          `post-reconcile-from-bob-to-${survivorName}`,
        ]),
      );

      const aliceCursorAfterFirstStabilize = alice.getGroup("demo").fetchCursor;
      const bobCursorAfterFirstStabilize = bob.getGroup("demo").fetchCursor;

      await alice.syncGroup("demo");
      await bob.syncGroup("demo");

      expect(alice.getGroup("demo").fetchCursor).toBeGreaterThanOrEqual(
        aliceCursorAfterFirstStabilize,
      );
      expect(bob.getGroup("demo").fetchCursor).toBeGreaterThanOrEqual(
        bobCursorAfterFirstStabilize,
      );

      const erinInvitation = await survivor.addMember(
        "demo",
        erin.stablePubkey,
      );
      await survivor.syncGroup("demo");

      await erin.fetchWelcomes();
      await erin.acceptWelcome(erinInvitation.keyPackageReference, "demo");

      await survivor.sendMessage("demo", `welcome-erin-via-${survivorName}`);
      const erinMessages = await erin.syncGroup("demo");

      expect(erinMessages.map((message) => message.plaintext)).toEqual([
        `welcome-erin-via-${survivorName}`,
      ]);
      expect(erin.listGroups()).toHaveLength(1);

      expect(await rejectedSession.fetchWelcomes()).toEqual([]);
      expect(await rejectedSession.fetchWelcomes()).toEqual([]);

      const syncIssueCountsBeforeIdempotence = new Map([
        [alice.stablePubkey, alice.listSyncIssues("demo").length],
        [bob.stablePubkey, bob.listSyncIssues("demo").length],
        [survivor.stablePubkey, survivor.listSyncIssues("demo").length],
      ]);

      const aliceCursorBeforeIdempotence = alice.getGroup("demo").fetchCursor;
      const bobCursorBeforeIdempotence = bob.getGroup("demo").fetchCursor;
      const survivorCursorBeforeIdempotence =
        survivor.getGroup("demo").fetchCursor;

      expect(
        (await alice.syncGroup("demo")).map((message) => message.plaintext),
      ).toEqual(expect.arrayContaining([`welcome-erin-via-${survivorName}`]));
      expect(
        (await bob.syncGroup("demo")).map((message) => message.plaintext),
      ).toEqual(expect.arrayContaining([`welcome-erin-via-${survivorName}`]));
      expect(await survivor.syncGroup("demo")).toEqual([]);

      expect(await alice.syncGroup("demo")).toEqual([]);
      expect(await bob.syncGroup("demo")).toEqual([]);
      expect(await survivor.syncGroup("demo")).toEqual([]);

      expect(alice.getGroup("demo").fetchCursor).toBeGreaterThanOrEqual(
        aliceCursorBeforeIdempotence,
      );
      expect(bob.getGroup("demo").fetchCursor).toBeGreaterThanOrEqual(
        bobCursorBeforeIdempotence,
      );
      expect(survivor.getGroup("demo").fetchCursor).toBeGreaterThanOrEqual(
        survivorCursorBeforeIdempotence,
      );

      expect(alice.listSyncIssues("demo")).toHaveLength(
        syncIssueCountsBeforeIdempotence.get(alice.stablePubkey) ?? 0,
      );
      expect(bob.listSyncIssues("demo")).toHaveLength(
        syncIssueCountsBeforeIdempotence.get(bob.stablePubkey) ?? 0,
      );
      expect(survivor.listSyncIssues("demo")).toHaveLength(
        syncIssueCountsBeforeIdempotence.get(survivor.stablePubkey) ?? 0,
      );

      const daveRecoveryAlias = carolJoined
        ? "dave-recovery"
        : "carol-recovery";
      await rejectedSession.generateKeyPackage(daveRecoveryAlias);
      await rejectedSession.publishKeyPackage(daveRecoveryAlias);

      const recoveryInvitation = await bob.addMember(
        "demo",
        rejectedSession.stablePubkey,
      );
      await bob.syncGroup("demo");

      expect(await rejectedSession.fetchWelcomes()).toEqual([
        expect.objectContaining({
          keyPackageReference: recoveryInvitation.keyPackageReference,
        }),
      ]);
      await rejectedSession.acceptWelcome(
        recoveryInvitation.keyPackageReference,
        "demo-recovery",
      );

      await bob.sendMessage("demo", `reinvited-${rejectedName}-hello`);
      const recoveredMessages =
        await rejectedSession.syncGroup("demo-recovery");

      expect(recoveredMessages.map((message) => message.plaintext)).toEqual([
        `reinvited-${rejectedName}-hello`,
      ]);
      expect(rejectedSession.listGroups()).toHaveLength(1);

      for (const session of [alice, bob, survivor, erin, rejectedSession]) {
        const history = session.listMessages(
          session === rejectedSession ? "demo-recovery" : "demo",
        );
        const cursors = history.map((message) => message.cursor);
        expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
        expect(new Set(cursors).size).toBe(cursors.length);
      }

      expect(rejectedName).toMatch(/carol|dave/);
    } finally {
      await server.transport.close();
    }
  });

  test.each([
    {
      name: "alice-bob-survivor",
      syncOrder: ["alice", "bob"] as const,
    },
    {
      name: "survivor-alice-bob",
      syncOrder: ["bob", "alice"] as const,
    },
    {
      name: "bob-survivor-alice",
      syncOrder: ["bob", "alice", "bob"] as const,
    },
  ])(
    "stays convergent across deterministic reconciliation order %s",
    async ({ syncOrder }) => {
      const relayHub = new MockRelayHub();
      const serverSigner = new PrivateKeySigner();
      const serverPubkey = await serverSigner.getPublicKey();
      const server = await connectServer({
        signer: serverSigner,
        relayHandler: relayHub.createRelayHandler(),
      });

      try {
        const alice = new CliSession({
          serverPubkey,
          relayHandler: relayHub.createRelayHandler(),
        });
        const bob = new CliSession({
          serverPubkey,
          relayHandler: relayHub.createRelayHandler(),
        });
        const carol = new CliSession({
          serverPubkey,
          relayHandler: relayHub.createRelayHandler(),
        });
        const dave = new CliSession({
          serverPubkey,
          relayHandler: relayHub.createRelayHandler(),
        });
        sessions.push(alice, bob, carol, dave);

        await alice.generateKeyPackage("alice-main");
        await bob.generateKeyPackage("bob-main");
        await carol.generateKeyPackage("carol-main");
        await dave.generateKeyPackage("dave-main");
        await bob.publishKeyPackage("bob-main");
        await carol.publishKeyPackage("carol-main");
        await dave.publishKeyPackage("dave-main");

        await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
        const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
        await alice.syncGroup("demo");

        await bob.fetchWelcomes();
        await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

        const carolInvitation = await alice.addMember(
          "demo",
          carol.stablePubkey,
        );
        const daveInvitation = await bob.addMember("demo", dave.stablePubkey);

        await Promise.all([
          alice.sendMessage("demo", "alice-race-msg"),
          bob.sendMessage("demo", "bob-race-msg"),
        ]);

        for (const actor of syncOrder) {
          const session = actor === "alice" ? alice : bob;

          await session.syncGroup("demo");
          await carol.fetchWelcomes();
          await dave.fetchWelcomes();
        }

        await carol.fetchWelcomes();
        await dave.fetchWelcomes();

        const carolCanJoin = carol
          .listWelcomes()
          .some(
            (welcome) =>
              welcome.keyPackageReference ===
              carolInvitation.keyPackageReference,
          );
        const daveCanJoin = dave
          .listWelcomes()
          .some(
            (welcome) =>
              welcome.keyPackageReference ===
              daveInvitation.keyPackageReference,
          );

        expect(Number(carolCanJoin) + Number(daveCanJoin)).toBe(1);

        const survivor = carolCanJoin ? carol : dave;
        const rejected = carolCanJoin ? dave : carol;

        await survivor.acceptWelcome(
          carolCanJoin
            ? carolInvitation.keyPackageReference
            : daveInvitation.keyPackageReference,
          "demo",
        );
        await expect(
          rejected.acceptWelcome(
            carolCanJoin
              ? daveInvitation.keyPackageReference
              : carolInvitation.keyPackageReference,
            "demo",
          ),
        ).rejects.toThrow();

        expect(await rejected.fetchWelcomes()).toEqual([]);

        for (const session of [alice, bob, survivor]) {
          await session.syncGroup("demo");
          await session.syncGroup("demo");
        }

        const issueDetails = [
          ...alice.listSyncIssues("demo"),
          ...bob.listSyncIssues("demo"),
        ].map((issue) => issue.detail);

        expect(issueDetails).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/former epoch|epoch too old/),
          ]),
        );

        await alice.sendMessage("demo", "post-order-alice");
        await bob.sendMessage("demo", "post-order-bob");
        const survivorReceived = await survivor.syncGroup("demo");

        expect(survivorReceived.map((message) => message.plaintext)).toEqual([
          "post-order-alice",
          "post-order-bob",
        ]);

        for (const session of [alice, bob, survivor]) {
          const messages = session.listMessages("demo");
          const cursors = messages.map((message) => message.cursor);
          expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
          expect(new Set(cursors).size).toBe(cursors.length);
        }
      } finally {
        await server.transport.close();
      }
    },
  );

  test("isolates concurrent activity across multiple groups with overlapping actors", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const carol = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const dave = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const erin = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob, carol, dave, erin);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-a");
      await bob.generateKeyPackage("bob-b");
      await carol.generateKeyPackage("carol-a");
      await carol.generateKeyPackage("carol-b");
      await dave.generateKeyPackage("dave-b");
      await erin.generateKeyPackage("erin-a");
      await bob.publishKeyPackage("bob-a");
      await bob.publishKeyPackage("bob-b");
      await carol.publishKeyPackage("carol-a");
      await carol.publishKeyPackage("carol-b");
      await dave.publishKeyPackage("dave-b");
      await erin.publishKeyPackage("erin-a");

      await alice.createGroup("group-a", { keyPackageAlias: "alice-main" });
      await alice.createGroup("group-b", { keyPackageAlias: "alice-main" });

      const bobIntoA = await alice.addMember("group-a", bob.stablePubkey);
      await alice.syncGroup("group-a");
      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobIntoA.keyPackageReference, "group-a");

      const bobIntoB = await alice.addMember("group-b", bob.stablePubkey);
      await alice.syncGroup("group-b");
      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobIntoB.keyPackageReference, "group-b");

      const carolIntoA = await alice.addMember("group-a", carol.stablePubkey);
      const daveIntoB = await bob.addMember("group-b", dave.stablePubkey);

      await Promise.all([
        alice.sendMessage("group-a", "a-msg-1"),
        bob.sendMessage("group-b", "b-msg-1"),
        alice.sendMessage("group-b", "b-msg-2"),
        bob.sendMessage("group-a", "a-msg-2"),
      ]);

      expect(await carol.fetchWelcomes()).toEqual([]);
      expect(await dave.fetchWelcomes()).toEqual([]);

      await bob.syncGroup("group-a");
      await alice.syncGroup("group-b");
      await alice.syncGroup("group-a");
      await bob.syncGroup("group-b");

      await carol.fetchWelcomes();
      await dave.fetchWelcomes();

      expect(carol.listWelcomes()).toEqual([
        expect.objectContaining({
          keyPackageReference: carolIntoA.keyPackageReference,
        }),
      ]);
      expect(dave.listWelcomes()).toEqual([
        expect.objectContaining({
          keyPackageReference: daveIntoB.keyPackageReference,
        }),
      ]);

      await carol.acceptWelcome(carolIntoA.keyPackageReference, "group-a");
      await dave.acceptWelcome(daveIntoB.keyPackageReference, "group-b");

      const carolGroupAMessages = await carol.syncGroup("group-a");
      const daveGroupBMessages = await dave.syncGroup("group-b");

      expect(carolGroupAMessages).toEqual([]);
      expect(daveGroupBMessages).toEqual([]);

      expect(carol.listMessages("group-a")).toEqual([]);
      expect(dave.listMessages("group-b")).toEqual([]);

      await carol.generateKeyPackage("carol-race");
      await erin.generateKeyPackage("erin-race");
      await carol.publishKeyPackage("carol-race");
      await erin.publishKeyPackage("erin-race");

      const erinIntoA = await bob.addMember("group-a", erin.stablePubkey);
      const carolIntoB = await alice.addMember("group-b", carol.stablePubkey);

      await alice.syncGroup("group-a");
      await bob.syncGroup("group-b");
      await bob.syncGroup("group-a");
      await alice.syncGroup("group-b");

      await erin.fetchWelcomes();
      await carol.fetchWelcomes();

      expect(erin.listWelcomes()).toEqual([
        expect.objectContaining({
          keyPackageReference: erinIntoA.keyPackageReference,
        }),
      ]);
      expect(
        carol
          .listWelcomes()
          .map((welcome) => welcome.keyPackageReference)
          .filter((ref) => ref === carolIntoB.keyPackageReference),
      ).toEqual([carolIntoB.keyPackageReference]);

      await erin.acceptWelcome(erinIntoA.keyPackageReference, "group-a-erin");
      await carol.acceptWelcome(
        carolIntoB.keyPackageReference,
        "group-b-carol",
      );

      await bob.sendMessage("group-a", "group-a-post-join");
      await alice.sendMessage("group-b", "group-b-post-join");

      const erinReceived = await erin.syncGroup("group-a-erin");
      const carolGroupBReceived = await carol.syncGroup("group-b-carol");

      expect(erinReceived.map((message) => message.plaintext)).toEqual([
        "group-a-post-join",
      ]);
      expect(carolGroupBReceived.map((message) => message.plaintext)).toEqual([
        "group-b-post-join",
      ]);

      expect(alice.listSyncIssues("group-a")).toEqual([]);
      expect(alice.listSyncIssues("group-b")).toEqual([]);
      expect(bob.listSyncIssues("group-a")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringMatching(/epoch too old|former epoch/),
          }),
        ]),
      );
      expect(bob.listSyncIssues("group-b")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringMatching(/epoch too old|former epoch/),
          }),
        ]),
      );

      expect(
        carol
          .listGroups()
          .map((group) => group.alias)
          .sort(),
      ).toEqual(["group-a", "group-b-carol"]);
      expect(dave.listGroups().map((group) => group.alias)).toEqual([
        "group-b",
      ]);
      expect(erin.listGroups().map((group) => group.alias)).toEqual([
        "group-a-erin",
      ]);

      for (const [session, alias, forbidden] of [
        [alice, "group-a", "b-msg-1"],
        [alice, "group-b", "a-msg-1"],
        [bob, "group-a", "b-msg-1"],
        [bob, "group-b", "a-msg-1"],
        [carol, "group-a", "b-msg-1"],
        [dave, "group-b", "a-msg-1"],
      ] as const) {
        expect(
          session.listMessages(alias).map((message) => message.plaintext),
        ).not.toContain(forbidden);
      }

      expect(alice.getGroup("group-a").fetchCursor).toBeLessThanOrEqual(
        alice.getGroup("group-a").lastCursor,
      );
      expect(alice.getGroup("group-b").fetchCursor).toBeLessThanOrEqual(
        alice.getGroup("group-b").lastCursor,
      );
      expect(bob.getGroup("group-a").fetchCursor).toBeLessThanOrEqual(
        bob.getGroup("group-a").lastCursor,
      );
      expect(bob.getGroup("group-b").fetchCursor).toBeLessThanOrEqual(
        bob.getGroup("group-b").lastCursor,
      );
    } finally {
      await server.transport.close();
    }
  });

  test("keeps dual same-epoch races isolated across two overlapping groups", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const carol = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const dave = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const erin = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const frank = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob, carol, dave, erin, frank);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-a");
      await bob.generateKeyPackage("bob-b");
      await carol.generateKeyPackage("carol-a");
      await dave.generateKeyPackage("dave-a");
      await erin.generateKeyPackage("erin-b");
      await frank.generateKeyPackage("frank-b");
      await bob.publishKeyPackage("bob-a");
      await bob.publishKeyPackage("bob-b");
      await carol.publishKeyPackage("carol-a");
      await dave.publishKeyPackage("dave-a");
      await erin.publishKeyPackage("erin-b");
      await frank.publishKeyPackage("frank-b");

      await alice.createGroup("group-a", { keyPackageAlias: "alice-main" });
      await alice.createGroup("group-b", { keyPackageAlias: "alice-main" });

      const bobIntoA = await alice.addMember("group-a", bob.stablePubkey);
      await alice.syncGroup("group-a");
      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobIntoA.keyPackageReference, "group-a");

      const bobIntoB = await alice.addMember("group-b", bob.stablePubkey);
      await alice.syncGroup("group-b");
      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobIntoB.keyPackageReference, "group-b");

      await alice.sendMessage("group-a", "a-bootstrap");
      await bob.syncGroup("group-a");
      await alice.sendMessage("group-b", "b-bootstrap");
      await bob.syncGroup("group-b");

      const carolIntoA = await alice.addMember("group-a", carol.stablePubkey);
      const daveIntoA = await bob.addMember("group-a", dave.stablePubkey);
      const erinIntoB = await alice.addMember("group-b", erin.stablePubkey);
      const frankIntoB = await bob.addMember("group-b", frank.stablePubkey);

      await Promise.all([
        alice.sendMessage("group-a", "a-race-msg-from-alice"),
        bob.sendMessage("group-a", "a-race-msg-from-bob"),
        alice.sendMessage("group-b", "b-race-msg-from-alice"),
        bob.sendMessage("group-b", "b-race-msg-from-bob"),
      ]);

      expect(await carol.fetchWelcomes()).toEqual([]);
      expect(await dave.fetchWelcomes()).toEqual([]);
      expect(await erin.fetchWelcomes()).toEqual([]);
      expect(await frank.fetchWelcomes()).toEqual([]);

      await bob.syncGroup("group-a");
      await alice.syncGroup("group-b");
      await alice.syncGroup("group-a");
      await bob.syncGroup("group-b");

      await carol.fetchWelcomes();
      await dave.fetchWelcomes();
      await erin.fetchWelcomes();
      await frank.fetchWelcomes();

      const acceptedA = [
        carol
          .listWelcomes()
          .some(
            (welcome) =>
              welcome.keyPackageReference === carolIntoA.keyPackageReference,
          ),
        dave
          .listWelcomes()
          .some(
            (welcome) =>
              welcome.keyPackageReference === daveIntoA.keyPackageReference,
          ),
      ];
      const acceptedB = [
        erin
          .listWelcomes()
          .some(
            (welcome) =>
              welcome.keyPackageReference === erinIntoB.keyPackageReference,
          ),
        frank
          .listWelcomes()
          .some(
            (welcome) =>
              welcome.keyPackageReference === frankIntoB.keyPackageReference,
          ),
      ];

      expect(acceptedA.filter(Boolean)).toHaveLength(1);
      expect(acceptedB.filter(Boolean)).toHaveLength(1);

      const survivorA = acceptedA[0] ? carol : dave;
      const rejectedA = acceptedA[0] ? dave : carol;
      const survivorAAlias = acceptedA[0] ? "carol-a" : "dave-a";
      const rejectedAAlias = acceptedA[0] ? "dave-a" : "carol-a";
      const survivorARef = acceptedA[0]
        ? carolIntoA.keyPackageReference
        : daveIntoA.keyPackageReference;
      const rejectedARef = acceptedA[0]
        ? daveIntoA.keyPackageReference
        : carolIntoA.keyPackageReference;

      const survivorB = acceptedB[0] ? erin : frank;
      const rejectedB = acceptedB[0] ? frank : erin;
      const survivorBAlias = acceptedB[0] ? "erin-b" : "frank-b";
      const rejectedBAlias = acceptedB[0] ? "frank-b" : "erin-b";
      const survivorBRef = acceptedB[0]
        ? erinIntoB.keyPackageReference
        : frankIntoB.keyPackageReference;
      const rejectedBRef = acceptedB[0]
        ? frankIntoB.keyPackageReference
        : erinIntoB.keyPackageReference;

      await survivorA.acceptWelcome(survivorARef, "group-a");
      await expect(
        rejectedA.acceptWelcome(rejectedARef, "group-a"),
      ).rejects.toThrow();

      await survivorB.acceptWelcome(survivorBRef, "group-b");
      await expect(
        rejectedB.acceptWelcome(rejectedBRef, "group-b"),
      ).rejects.toThrow();

      expect(await rejectedA.fetchWelcomes()).toEqual([]);
      expect(await rejectedB.fetchWelcomes()).toEqual([]);

      await alice.sendMessage("group-a", `group-a-post-${survivorAAlias}`);
      await bob.sendMessage("group-b", `group-b-post-${survivorBAlias}`);

      const survivorAReceived = await survivorA.syncGroup("group-a");
      const survivorBReceived = await survivorB.syncGroup("group-b");

      expect(survivorAReceived.map((message) => message.plaintext)).toEqual([
        `group-a-post-${survivorAAlias}`,
      ]);
      expect(survivorBReceived.map((message) => message.plaintext)).toEqual([
        `group-b-post-${survivorBAlias}`,
      ]);

      expect(
        survivorA.listMessages("group-a").map((message) => message.plaintext),
      ).not.toContain(`group-b-post-${survivorBAlias}`);
      expect(
        survivorB.listMessages("group-b").map((message) => message.plaintext),
      ).not.toContain(`group-a-post-${survivorAAlias}`);

      expect(alice.listSyncIssues("group-a")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringMatching(/former epoch|epoch too old/),
          }),
        ]),
      );
      expect(bob.listSyncIssues("group-b")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringMatching(/former epoch|epoch too old/),
          }),
        ]),
      );

      for (const [session, alias] of [
        [alice, "group-a"],
        [alice, "group-b"],
        [bob, "group-a"],
        [bob, "group-b"],
        [survivorA, "group-a"],
        [survivorB, "group-b"],
      ] as const) {
        expect(session.getGroup(alias).fetchCursor).toBeLessThanOrEqual(
          session.getGroup(alias).lastCursor,
        );
      }

      for (const [session, alias] of [
        [alice, "group-a"],
        [alice, "group-b"],
        [bob, "group-a"],
        [bob, "group-b"],
        [survivorA, "group-a"],
        [survivorB, "group-b"],
      ] as const) {
        const cursors = session
          .listMessages(alias)
          .map((message) => message.cursor);
        expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
        expect(new Set(cursors).size).toBe(cursors.length);
      }

      expect(rejectedAAlias).toMatch(/carol-a|dave-a/);
      expect(rejectedBAlias).toMatch(/erin-b|frank-b/);
    } finally {
      await server.transport.close();
    }
  });

  test("survives a long-running multi-group syncAll schedule with reinvites and key-package exhaustion", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const carol = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const dave = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const erin = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const frank = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob, carol, dave, erin, frank);

      await alice.generateKeyPackage("alice-main");

      await bob.generateKeyPackage("bob-a1");
      await bob.generateKeyPackage("bob-b1");
      await bob.publishKeyPackage("bob-a1");
      await bob.publishKeyPackage("bob-b1");

      await carol.generateKeyPackage("carol-a1");
      await carol.generateKeyPackage("carol-b1");
      await carol.generateKeyPackage("carol-a2");
      await carol.publishKeyPackage("carol-a1");
      await carol.publishKeyPackage("carol-b1");
      await carol.publishKeyPackage("carol-a2");

      await dave.generateKeyPackage("dave-a1");
      await dave.generateKeyPackage("dave-b1");
      await dave.publishKeyPackage("dave-a1");
      await dave.publishKeyPackage("dave-b1");

      await erin.generateKeyPackage("erin-a1");
      await erin.generateKeyPackage("erin-b1");
      await erin.publishKeyPackage("erin-a1");
      await erin.publishKeyPackage("erin-b1");

      await frank.generateKeyPackage("frank-b1");
      await frank.publishKeyPackage("frank-b1");

      await alice.createGroup("group-a", { keyPackageAlias: "alice-main" });
      await alice.createGroup("group-b", { keyPackageAlias: "alice-main" });

      const bobIntoA = await alice.addMember("group-a", bob.stablePubkey);
      await alice.syncAll();
      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobIntoA.keyPackageReference, "group-a");

      const bobIntoB = await alice.addMember("group-b", bob.stablePubkey);
      await alice.syncAll();
      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobIntoB.keyPackageReference, "group-b");

      await alice.sendMessage("group-a", "a-bootstrap-1");
      await alice.sendMessage("group-b", "b-bootstrap-1");
      const bobBootstrap = await bob.syncAll();

      expect(
        bobBootstrap["group-a"]?.map((message) => message.plaintext),
      ).toEqual(["a-bootstrap-1"]);
      expect(
        bobBootstrap["group-b"]?.map((message) => message.plaintext),
      ).toEqual(["b-bootstrap-1"]);

      const carolIntoA = await alice.addMember("group-a", carol.stablePubkey);
      const daveIntoB = await bob.addMember("group-b", dave.stablePubkey);
      await Promise.all([
        alice.sendMessage("group-a", "a-round-1-from-alice"),
        bob.sendMessage("group-a", "a-round-1-from-bob"),
        alice.sendMessage("group-b", "b-round-1-from-alice"),
        bob.sendMessage("group-b", "b-round-1-from-bob"),
      ]);

      const aliceRoundOne = await alice.syncAll();
      const bobRoundOne = await bob.syncAll();

      expect(
        aliceRoundOne["group-a"]?.map((message) => message.plaintext),
      ).toEqual(expect.arrayContaining(["a-round-1-from-bob"]));
      expect(
        bobRoundOne["group-b"]?.map((message) => message.plaintext),
      ).toEqual(expect.arrayContaining(["b-round-1-from-alice"]));

      await carol.fetchWelcomes();
      await dave.fetchWelcomes();
      await carol.acceptWelcome(carolIntoA.keyPackageReference, "group-a");
      await dave.acceptWelcome(daveIntoB.keyPackageReference, "group-b");

      expect((await carol.syncAll())["group-a"]).toEqual([]);
      expect((await dave.syncAll())["group-b"]).toEqual([]);

      const erinIntoA = await bob.addMember("group-a", erin.stablePubkey);
      const carolIntoB = await alice.addMember("group-b", carol.stablePubkey);

      await alice.sendMessage("group-a", "a-round-2-from-alice");
      await bob.sendMessage("group-b", "b-round-2-from-bob");
      await carol.syncAll();
      await dave.syncAll();
      await alice.syncAll();
      await bob.syncAll();

      await erin.fetchWelcomes();
      await carol.fetchWelcomes();
      await erin.acceptWelcome(erinIntoA.keyPackageReference, "group-a-erin");
      await carol.acceptWelcome(
        carolIntoB.keyPackageReference,
        "group-b-carol",
      );

      await bob.sendMessage("group-a", "a-post-erin-join");
      await alice.sendMessage("group-b", "b-post-carol-join");

      const erinJoinedSync = await erin.syncAll();
      const carolSecondJoinedSync = await carol.syncAll();

      expect(
        erinJoinedSync["group-a-erin"]?.map((message) => message.plaintext),
      ).toEqual(["a-post-erin-join"]);
      expect(
        carolSecondJoinedSync["group-b-carol"]?.map(
          (message) => message.plaintext,
        ),
      ).toEqual(["b-post-carol-join"]);

      const carolReinviteIntoA = await alice.addMember(
        "group-a",
        carol.stablePubkey,
      );
      await alice.syncAll();
      await bob.syncAll();
      await carol.fetchWelcomes();
      await carol.acceptWelcome(
        carolReinviteIntoA.keyPackageReference,
        "group-a-rejoin",
      );

      await bob.sendMessage("group-a", "a-reinvite-msg");
      const carolRejoinSync = await carol.syncAll();
      expect(
        carolRejoinSync["group-a-rejoin"]?.map((message) => message.plaintext),
      ).toEqual(["a-reinvite-msg"]);

      const frankIntoA = await bob.addMember("group-a", frank.stablePubkey);
      await bob.syncAll();
      await frank.fetchWelcomes();
      await frank.acceptWelcome(
        frankIntoA.keyPackageReference,
        "group-a-frank",
      );

      await bob.sendMessage("group-a", "a-post-frank-join");
      const frankJoinedSync = await frank.syncAll();
      expect(
        frankJoinedSync["group-a-frank"]?.map((message) => message.plaintext),
      ).toEqual(["a-post-frank-join"]);

      await expect(
        alice.addMember("group-b", frank.stablePubkey),
      ).rejects.toBeInstanceOf(NoPublishedKeyPackageError);

      const daveReinviteIntoB = await bob.addMember(
        "group-b",
        dave.stablePubkey,
      );
      await bob.syncAll();
      await dave.fetchWelcomes();
      await dave.acceptWelcome(
        daveReinviteIntoB.keyPackageReference,
        "group-b-rejoin",
      );

      await bob.sendMessage("group-b", "b-post-dave-rejoin");
      const daveRejoinSync = await dave.syncAll();
      expect(
        daveRejoinSync["group-b-rejoin"]?.map((message) => message.plaintext),
      ).toEqual(["b-post-dave-rejoin"]);

      await expect(
        alice.addMember("group-a", dave.stablePubkey),
      ).rejects.toBeInstanceOf(NoPublishedKeyPackageError);

      const aliceDrain = await alice.syncAll();
      const bobDrain = await bob.syncAll();
      const carolDrain = await carol.syncAll();
      const daveDrain = await dave.syncAll();
      const erinDrain = await erin.syncAll();
      const frankDrain = await frank.syncAll();

      expect(
        aliceDrain["group-a"]?.map((message) => message.plaintext),
      ).toEqual(
        expect.arrayContaining(["a-reinvite-msg", "a-post-frank-join"]),
      );
      expect(bobDrain["group-b"] ?? []).toEqual([]);
      expect(
        carolDrain["group-a-rejoin"]?.map((message) => message.plaintext),
      ).toEqual(expect.arrayContaining(["a-post-frank-join"]));
      expect(daveDrain["group-b-rejoin"] ?? []).toEqual([]);
      expect(
        erinDrain["group-a-erin"]?.map((message) => message.plaintext),
      ).toEqual(
        expect.arrayContaining(["a-reinvite-msg", "a-post-frank-join"]),
      );
      expect(frankDrain["group-a-frank"] ?? []).toEqual([]);

      const aliceAll = await alice.syncAll();
      const bobAll = await bob.syncAll();
      const carolAll = await carol.syncAll();
      const daveAll = await dave.syncAll();
      const erinAll = await erin.syncAll();
      const frankAll = await frank.syncAll();

      expect(aliceAll["group-a"] ?? []).toEqual([]);
      expect(bobAll["group-b"] ?? []).toEqual([]);
      expect(carolAll["group-a"] ?? []).toEqual([]);
      expect(daveAll["group-b"] ?? []).toEqual([]);
      expect(erinAll["group-a-erin"] ?? []).toEqual([]);
      expect(frankAll["group-a-frank"] ?? []).toEqual([]);

      expect(
        carol
          .listGroups()
          .map((group) => group.alias)
          .sort(),
      ).toEqual(["group-a", "group-a-rejoin", "group-b-carol"]);
      expect(
        dave
          .listGroups()
          .map((group) => group.alias)
          .sort(),
      ).toEqual(["group-b", "group-b-rejoin"]);
      expect(erin.listGroups().map((group) => group.alias)).toEqual([
        "group-a-erin",
      ]);
      expect(frank.listGroups().map((group) => group.alias)).toEqual([
        "group-a-frank",
      ]);

      for (const [session, alias, expected, forbidden] of [
        [alice, "group-a", "a-reinvite-msg", "b-post-carol-join"],
        [alice, "group-b", "b-post-carol-join", "a-reinvite-msg"],
        [bob, "group-a", "a-reinvite-msg", "b-post-carol-join"],
        [bob, "group-b", "b-post-carol-join", "a-reinvite-msg"],
        [carol, "group-a", "a-round-2-from-alice", "b-post-carol-join"],
        [dave, "group-b", "b-round-2-from-bob", "a-reinvite-msg"],
        [dave, "group-b-rejoin", "b-post-dave-rejoin", "a-reinvite-msg"],
        [erin, "group-a-erin", "a-post-erin-join", "b-post-carol-join"],
        [frank, "group-a-frank", "a-post-frank-join", "b-post-carol-join"],
      ] as const) {
        const plaintexts = session
          .listMessages(alias)
          .map((message) => message.plaintext);
        expect(plaintexts).toContain(expected);
        expect(plaintexts).not.toContain(forbidden);
      }

      for (const [session, alias] of [
        [alice, "group-a"],
        [alice, "group-b"],
        [bob, "group-a"],
        [bob, "group-b"],
        [carol, "group-a"],
        [carol, "group-b-carol"],
        [carol, "group-a-rejoin"],
        [dave, "group-b"],
        [dave, "group-b-rejoin"],
        [erin, "group-a-erin"],
        [frank, "group-a-frank"],
      ] as const) {
        expect(session.getGroup(alias).fetchCursor).toBeLessThanOrEqual(
          session.getGroup(alias).lastCursor,
        );

        const cursors = session
          .listMessages(alias)
          .map((message) => message.cursor);
        expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
        expect(new Set(cursors).size).toBe(cursors.length);
      }
    } finally {
      await server.transport.close();
    }
  });

  test("builds a full conversation view by syncing first and then returning in-memory history", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bob = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const carol = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      sessions.push(alice, bob, carol);

      await alice.generateKeyPackage("alice-main");
      await bob.generateKeyPackage("bob-main");
      await carol.generateKeyPackage("carol-main");
      await bob.publishKeyPackage("bob-main");
      await carol.publishKeyPackage("carol-main");

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "hello bob");
      await bob.syncGroup("demo");
      await bob.sendMessage("demo", "hello alice");
      await alice.syncGroup("demo");

      const carolInvitation = await alice.addMember("demo", carol.stablePubkey);
      await alice.syncGroup("demo");

      await carol.fetchWelcomes();
      await carol.acceptWelcome(carolInvitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "welcome carol");
      await bob.syncGroup("demo");
      await bob.sendMessage("demo", "glad you joined");

      const conversation = await carol.getConversation("demo");

      expect(conversation.synced.map((message) => message.plaintext)).toEqual([
        "welcome carol",
        "glad you joined",
      ]);
      expect(conversation.synced.map((message) => message.sender)).toEqual([
        alice.stablePubkey,
        bob.stablePubkey,
      ]);
      expect(conversation.messages.map((message) => message.plaintext)).toEqual(
        ["welcome carol", "glad you joined"],
      );
    } finally {
      await server.transport.close();
    }
  });
});
