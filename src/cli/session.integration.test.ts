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

      await alice.createGroup("demo", "alice-main");
      const invitation = await alice.addMember("demo", bob.stablePubkey);

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

      await alice.createGroup("demo", "alice-main");
      const invitation = await alice.addMember("demo", published.keyPackageRef);

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

      await alice.createGroup("demo", "alice-main");
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "hello bob");
      await bob.syncGroup("demo");
      await bob.sendMessage("demo", "hello alice");
      await alice.syncGroup("demo");

      const carolInvitation = await alice.addMember("demo", carol.stablePubkey);
      const aliceMessagesAfterCommit = await alice.syncGroup("demo");

      expect(aliceMessagesAfterCommit).toEqual([]);
      expect(alice.listSyncIssues("demo")).toEqual([
        expect.objectContaining({
          detail: "Cannot process commit or proposal from former epoch",
        }),
      ]);

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

      await alice.createGroup("demo", "alice-main");
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);

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
