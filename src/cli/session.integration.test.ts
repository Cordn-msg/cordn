import { afterEach, describe, expect, test } from "vitest";

import { CliSession } from "./session.ts";
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
