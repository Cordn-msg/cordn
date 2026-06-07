import { afterEach, describe, expect, test } from "vitest";

import { CliSession } from "./session.ts";
import {
  NoPublishedKeyPackageError,
  RemovedFromGroupError,
  UnauthorizedGroupAdminActionError,
} from "./sessionErrors.ts";
import { connectServer } from "../server/coordinatorServer.ts";
import { MockRelayHub } from "../test/mockRelay.ts";
import { PrivateKeySigner } from "@contextvm/sdk";

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const invitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(invitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "hello bob");
      const synced = await bob.syncGroup("demo");

      expect(synced).toHaveLength(1);
      expect(synced[0]?.content).toBe("hello bob");
      expect(synced[0]?.sender).toBe(alice.stablePubkey);

      await bob.sendMessage("demo", "hello alice");
      const aliceSynced = await alice.syncGroup("demo");

      expect(aliceSynced).toHaveLength(1);
      expect(aliceSynced[0]?.content).toBe("hello alice");
      expect(aliceSynced[0]?.sender).toBe(bob.stablePubkey);
    } finally {
      await server.transport.close();
    }
  });

  test("removes a member and prevents further sends from the removed session", async () => {
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

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const invitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(invitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "before-remove");
      expect(
        (await bob.syncGroup("demo")).map((message) => message.content),
      ).toEqual(["before-remove"]);

      await alice.removeMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.syncGroup("demo");

      expect(bob.getGroup("demo").status).toBe("removed");
      await expect(
        bob.sendMessage("demo", "after-remove"),
      ).rejects.toBeInstanceOf(RemovedFromGroupError);

      await alice.sendMessage("demo", "after-remove-from-alice");
      expect(
        (await alice.syncGroup("demo")).map((message) => message.content),
      ).toEqual([]);
      await expect(bob.syncGroup("demo")).rejects.toBeInstanceOf(
        RemovedFromGroupError,
      );
    } finally {
      await Promise.allSettled(
        sessions.splice(0).map((session) => session.disconnect()),
      );
      await server.transport.close();
    }
  });

  test("blocks send after a remote removal even before explicit sync", async () => {
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

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const invitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(invitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "before-remove");
      await bob.syncGroup("demo");

      await alice.removeMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await expect(
        bob.sendMessage("demo", "after-remove-without-manual-sync"),
      ).rejects.toBeInstanceOf(RemovedFromGroupError);
      expect(bob.getGroup("demo").status).toBe("removed");
    } finally {
      await Promise.allSettled(
        sessions.splice(0).map((session) => session.disconnect()),
      );
      await server.transport.close();
    }
  });

  test("routes group operations through the bound coordinator while key package listing stays selectable", async () => {
    const relayHub = new MockRelayHub();
    const coordinatorASigner = new PrivateKeySigner();
    const coordinatorBSigner = new PrivateKeySigner();
    const coordinatorAPubkey = await coordinatorASigner.getPublicKey();
    const coordinatorBPubkey = await coordinatorBSigner.getPublicKey();
    const coordinatorA = await connectServer({
      signer: coordinatorASigner,
      relayHandler: relayHub.createRelayHandler(),
    });
    const coordinatorB = await connectServer({
      signer: coordinatorBSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey: coordinatorAPubkey,
        relayHandler: relayHub.createRelayHandler(),
        coordinators: {
          [coordinatorBPubkey]: {
            serverPubkey: coordinatorBPubkey,
            relayHandler: relayHub.createRelayHandler(),
          },
        },
      });
      const bob = new CliSession({
        serverPubkey: coordinatorBPubkey,
        relayHandler: relayHub.createRelayHandler(),
        coordinators: {
          [coordinatorAPubkey]: {
            serverPubkey: coordinatorAPubkey,
            relayHandler: relayHub.createRelayHandler(),
          },
        },
      });
      sessions.push(alice, bob);

      await alice.generateKeyPackage("alice-main", { localOnly: true });
      await bob.generateKeyPackage("bob-main", { localOnly: true });
      await bob.publishKeyPackage("bob-main", {
        coordinatorKey: coordinatorBPubkey,
      });

      expect(await alice.listAvailableKeyPackageSummaries()).toEqual([]);
      expect(
        await alice.listAvailableKeyPackageSummaries(coordinatorBPubkey),
      ).toHaveLength(1);

      await alice.createGroup("demo", {
        keyPackageAlias: "alice-main",
        coordinatorKey: coordinatorBPubkey,
      });
      const invitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      const welcomes = await bob.fetchWelcomes(coordinatorBPubkey);
      expect(
        welcomes.some(
          (welcome) => welcome.kp_ref === invitation.keyPackageReference,
        ),
      ).toBe(true);
      await bob.acceptWelcome(
        invitation.keyPackageReference,
        "demo",
        coordinatorBPubkey,
      );

      await alice.sendMessage("demo", "hello from coordinator b");
      const synced = await bob.syncGroup("demo");

      expect(alice.getGroup("demo").coordinatorKey).toBe(coordinatorBPubkey);
      expect(bob.getGroup("demo").coordinatorKey).toBe(coordinatorBPubkey);
      expect(synced).toHaveLength(1);
      expect(synced[0]?.content).toBe("hello from coordinator b");
    } finally {
      await coordinatorA.transport.close();
      await coordinatorB.transport.close();
    }
  });

  test("accept-welcome keeps the fetched coordinator binding when no coordinator override is provided", async () => {
    const relayHub = new MockRelayHub();
    const coordinatorASigner = new PrivateKeySigner();
    const coordinatorBSigner = new PrivateKeySigner();
    const coordinatorAPubkey = await coordinatorASigner.getPublicKey();
    const coordinatorBPubkey = await coordinatorBSigner.getPublicKey();
    const coordinatorA = await connectServer({
      signer: coordinatorASigner,
      relayHandler: relayHub.createRelayHandler(),
    });
    const coordinatorB = await connectServer({
      signer: coordinatorBSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey: coordinatorAPubkey,
        relayHandler: relayHub.createRelayHandler(),
        coordinators: {
          [coordinatorBPubkey]: {
            serverPubkey: coordinatorBPubkey,
            relayHandler: relayHub.createRelayHandler(),
          },
        },
      });
      const bob = new CliSession({
        serverPubkey: coordinatorAPubkey,
        relayHandler: relayHub.createRelayHandler(),
        coordinators: {
          [coordinatorBPubkey]: {
            serverPubkey: coordinatorBPubkey,
            relayHandler: relayHub.createRelayHandler(),
          },
        },
      });
      sessions.push(alice, bob);

      await alice.generateKeyPackage("alice-main", { localOnly: true });
      await bob.generateKeyPackage("bob-main", { localOnly: true });
      await bob.publishKeyPackage("bob-main", {
        coordinatorKey: coordinatorBPubkey,
      });

      await alice.createGroup("demo", {
        keyPackageAlias: "alice-main",
        coordinatorKey: coordinatorBPubkey,
      });
      const invitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      const welcomes = await bob.fetchWelcomes(coordinatorBPubkey);
      const storedWelcome = welcomes.find(
        (welcome) => welcome.kp_ref === invitation.keyPackageReference,
      );

      expect(storedWelcome?.coordinatorKey).toBe(coordinatorBPubkey);

      await bob.acceptWelcome(invitation.keyPackageReference, "demo");

      expect(bob.getGroup("demo").coordinatorKey).toBe(coordinatorBPubkey);

      await alice.sendMessage("demo", "hello after implicit welcome binding");
      const synced = await bob.syncGroup("demo");

      expect(synced).toHaveLength(1);
      expect(synced[0]?.content).toBe("hello after implicit welcome binding");
    } finally {
      await coordinatorA.transport.close();
      await coordinatorB.transport.close();
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

      expect(bobReceived.map((message) => message.content)).toEqual([
        "alice-1",
        "alice-2",
        "alice-3",
      ]);
      expect(
        bob
          .listMessages("demo")
          .filter((message) => message.direction === "inbound")
          .map((message) => message.content),
      ).toEqual(["alice-1", "alice-2", "alice-3"]);
    } finally {
      await server.transport.close();
    }
  });

  test("supports last-resort generation and explicit deletion", async () => {
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
      sessions.push(alice);

      const generated = await alice.generateKeyPackage("alice-recovery", {
        lastResort: true,
      });

      expect(generated.isLastResort).toBe(true);
      expect(
        (await alice.listAvailableKeyPackageSummaries()).some(
          (entry) =>
            entry.keyPackageRef === generated.keyPackageRef &&
            entry.isLastResort === true,
        ),
      ).toBe(true);

      await alice.deleteKeyPackage("alice-recovery");

      expect(
        (await alice.listAvailableKeyPackageSummaries()).some(
          (entry) => entry.keyPackageRef === generated.keyPackageRef,
        ),
      ).toBe(false);
    } finally {
      await server.transport.close();
    }
  });

  test("reports accurate errors when deleting a non-existent key package ref", async () => {
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
      sessions.push(alice);

      await expect(
        alice.deleteKeyPackage("kp-ref-does-not-exist"),
      ).rejects.toThrow("Unknown key package ref: kp-ref-does-not-exist");
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
      expect(synced[0]?.content).toBe("hello exact key package");
    } finally {
      await server.transport.close();
    }
  });

  test("creates a group without requiring a pre-generated local key package", async () => {
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
      sessions.push(alice);

      expect(alice.listKeyPackageSummaries()).toEqual([]);

      const group = await alice.createGroup("demo");

      expect(group.alias).toBe("demo");
      expect(alice.listKeyPackageSummaries()).toHaveLength(1);
      expect(alice.listKeyPackageSummaries()[0]?.publishedAt).toBeUndefined();
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

  test("keeps egalitarian groups open to member admin actions", async () => {
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

      await alice.createGroup("demo", {
        keyPackageAlias: "alice-main",
        metadata: { name: "Demo Group" },
      });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");
      await bob.publishKeyPackage("bob-main");
      await carol.publishKeyPackage("carol-main");

      const carolInvitation = await bob.addMember("demo", carol.stablePubkey);
      await bob.syncGroup("demo");

      await carol.fetchWelcomes();
      const joined = await carol.acceptWelcome(
        carolInvitation.keyPackageReference,
        "demo",
      );

      expect(joined.metadata).toEqual({ name: "Demo Group" });
    } finally {
      await server.transport.close();
    }
  });

  test("rejects non-admin outbound add-member attempts when admins are configured", async () => {
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

      await alice.createGroup("demo", {
        keyPackageAlias: "alice-main",
        metadata: {
          name: "Admins Only",
          adminPubkeys: [alice.stablePubkey],
        },
      });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

      await expect(
        bob.addMember("demo", carol.stablePubkey),
      ).rejects.toBeInstanceOf(UnauthorizedGroupAdminActionError);
    } finally {
      await server.transport.close();
    }
  });

  test("rejects non-admin outbound metadata updates when admins are configured", async () => {
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

      await alice.createGroup("demo", {
        keyPackageAlias: "alice-main",
        metadata: {
          name: "Admins Only",
          description: "locked",
          adminPubkeys: [alice.stablePubkey],
        },
      });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      const joined = await bob.acceptWelcome(
        bobInvitation.keyPackageReference,
        "demo",
      );

      expect(joined.metadata).toEqual({
        name: "Admins Only",
        description: "locked",
        adminPubkeys: [alice.stablePubkey],
      });

      await expect(
        bob.updateGroupMetadata("demo", {
          name: "Bob takeover",
          description: "should not apply",
          adminPubkeys: [bob.stablePubkey],
        }),
      ).rejects.toBeInstanceOf(UnauthorizedGroupAdminActionError);

      expect(bob.listSyncIssues("demo")).toEqual([]);
      expect(bob.getGroup("demo").metadata).toEqual({
        name: "Admins Only",
        description: "locked",
        adminPubkeys: [alice.stablePubkey],
      });

      await alice.syncGroup("demo");
      await bob.syncGroup("demo");

      expect(alice.getGroup("demo").metadata).toEqual({
        name: "Admins Only",
        description: "locked",
        adminPubkeys: [alice.stablePubkey],
      });
      expect(bob.getGroup("demo").metadata).toEqual({
        name: "Admins Only",
        description: "locked",
        adminPubkeys: [alice.stablePubkey],
      });
    } finally {
      await server.transport.close();
    }
  });

  test("rejects non-admin outbound remove-member attempts when admins are configured", async () => {
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

      await alice.createGroup("demo", {
        keyPackageAlias: "alice-main",
        metadata: {
          name: "Admins Only",
          adminPubkeys: [alice.stablePubkey],
        },
      });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

      const carolInvitation = await alice.addMember("demo", carol.stablePubkey);
      await alice.syncGroup("demo");

      await carol.fetchWelcomes();
      await carol.acceptWelcome(carolInvitation.keyPackageReference, "demo");

      await expect(
        bob.removeMember("demo", carol.stablePubkey),
      ).rejects.toBeInstanceOf(UnauthorizedGroupAdminActionError);

      await alice.syncGroup("demo");
      await bob.syncGroup("demo");
      await carol.syncGroup("demo");

      expect(
        alice.listGroups().find((group) => group.alias === "demo")?.metadata,
      ).toEqual({
        name: "Admins Only",
        adminPubkeys: [alice.stablePubkey],
      });
      expect(
        bob.listGroups().find((group) => group.alias === "demo")?.metadata,
      ).toEqual({
        name: "Admins Only",
        adminPubkeys: [alice.stablePubkey],
      });
    } finally {
      await server.transport.close();
    }
  });

  test("keeps repeated unauthorized admin attempts harmless until a valid admin acts", async () => {
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
      await carol.publishKeyPackage("carol-main");
      await dave.publishKeyPackage("dave-main");

      await alice.createGroup("demo", {
        keyPackageAlias: "alice-main",
        metadata: {
          name: "Admins Only",
          adminPubkeys: [alice.stablePubkey],
        },
      });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

      for (const attempt of [
        () => bob.addMember("demo", carol.stablePubkey),
        () =>
          bob.updateGroupMetadata("demo", {
            name: "Bob takeover",
            adminPubkeys: [bob.stablePubkey],
          }),
        () => bob.removeMember("demo", alice.stablePubkey),
        () => bob.addMember("demo", dave.stablePubkey),
      ]) {
        await expect(attempt()).rejects.toBeInstanceOf(
          UnauthorizedGroupAdminActionError,
        );
      }

      expect(bob.listSyncIssues("demo")).toEqual([]);

      const carolInvitation = await alice.addMember("demo", carol.stablePubkey);
      await alice.syncGroup("demo");

      await carol.fetchWelcomes();
      const joined = await carol.acceptWelcome(
        carolInvitation.keyPackageReference,
        "demo",
      );

      expect(joined.metadata).toEqual({
        name: "Admins Only",
        adminPubkeys: [alice.stablePubkey],
      });

      await bob.syncGroup("demo");
      expect(
        bob.listGroups().find((group) => group.alias === "demo")?.metadata,
      ).toEqual({
        name: "Admins Only",
        adminPubkeys: [alice.stablePubkey],
      });
    } finally {
      await server.transport.close();
    }
  });

  test("starts rejecting non-admin actions immediately after admin metadata becomes restrictive", async () => {
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

      await alice.createGroup("demo", {
        keyPackageAlias: "alice-main",
        metadata: { name: "Initially Open" },
      });
      const bobInvitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(bobInvitation.keyPackageReference, "demo");

      const renamed = await alice.updateGroupMetadata("demo", {
        name: "Admins Only",
        adminPubkeys: [alice.stablePubkey],
      });
      expect(renamed.metadata).toEqual({
        name: "Admins Only",
        adminPubkeys: [alice.stablePubkey],
      });

      await alice.syncGroup("demo");
      await bob.syncGroup("demo");

      expect(bob.getGroup("demo").metadata).toEqual({
        name: "Admins Only",
        adminPubkeys: [alice.stablePubkey],
      });

      await expect(
        bob.addMember("demo", carol.stablePubkey),
      ).rejects.toBeInstanceOf(UnauthorizedGroupAdminActionError);
      await expect(
        bob.updateGroupMetadata("demo", {
          name: "Bob relock",
          adminPubkeys: [bob.stablePubkey],
        }),
      ).rejects.toBeInstanceOf(UnauthorizedGroupAdminActionError);
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
      expect(carolSynced[0]?.content).toBe("hello carol");
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

      expect(aliceReceived.map((message) => message.content)).toEqual([
        "hello everyone",
      ]);
      expect(bobReceived.map((message) => message.content)).toEqual([
        "hello everyone",
      ]);
      expect(aliceReceived[0]?.sender).toBe(carol.stablePubkey);
      expect(bobReceived[0]?.sender).toBe(carol.stablePubkey);
      expect(
        alice.listMessages("demo").map((message) => message.content),
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

      expect(carol.listWelcomes().map((welcome) => welcome.kp_ref)).toEqual([
        carolInvitation.keyPackageReference,
      ]);
      expect(dave.listWelcomes().map((welcome) => welcome.kp_ref)).toEqual([
        daveInvitation.keyPackageReference,
      ]);

      expect(alice.listSyncIssues("demo")).toEqual([]);
      expect(bob.listSyncIssues("demo")).toEqual([]);

      await carol.acceptWelcome(carolInvitation.keyPackageReference, "demo");

      await dave.acceptWelcome(daveInvitation.keyPackageReference, "demo");

      await alice.sendMessage("demo", "post-conflict hello");
      const bobReceived = await bob.syncGroup("demo");

      expect(bobReceived.map((message) => message.content)).toEqual([
        "post-conflict hello",
      ]);

      expect(carol.listGroups()).toHaveLength(1);
      expect(dave.listGroups()).toHaveLength(1);
    } finally {
      await server.transport.close();
    }
  });

  test("establishes a post-welcome baseline before watch mode starts", async () => {
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

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const invitation = await alice.addMember("demo", bob.stablePubkey);
      const inviterSync = await alice.syncGroup("demo");

      expect(inviterSync).toEqual([]);

      await bob.fetchWelcomes();
      const joined = await bob.acceptWelcome(
        invitation.keyPackageReference,
        "demo",
      );

      expect(joined.alias).toBe("demo");
      expect(bob.getGroup("demo").fetchCursor).toBe(1);
      expect(bob.listSyncIssues("demo")).toEqual([]);

      expect(bob.listSyncIssues("demo")).toEqual([]);
    } finally {
      await server.transport.close();
    }
  });

  test("keeps receiving live messages after sending while watch mode is active", async () => {
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

      const watchEvents: Array<{
        received: string[];
        issues: string[];
        watchStatus: string;
        error?: string;
      }> = [];
      const unsubscribe = bob.onWatchEvent((event) => {
        watchEvents.push({
          received: event.received.map((message) => message.content),
          issues: event.issues.map((issue) => issue.detail),
          watchStatus: event.watchStatus,
          error: event.error,
        });
      });

      try {
        await bob.watchGroup("demo");
        await waitForCondition(() => bob.getWatchStatus("demo") === "watching");

        expect(bob.getWatchStatus("demo")).toBe("watching");

        await bob.sendMessage("demo", "hello alice from bob");
        await alice.syncGroup("demo");

        await alice.sendMessage("demo", "hello bob after your send");
        await waitForCondition(() =>
          bob
            .listMessages("demo")
            .some(
              (message) =>
                message.direction === "inbound" &&
                message.content === "hello bob after your send",
            ),
        );

        expect(bob.getWatchStatus("demo")).toBe("watching");
        expect(
          bob
            .listMessages("demo")
            .filter((message) => message.direction === "inbound")
            .map((message) => message.content),
        ).toContain("hello bob after your send");
        expect(
          watchEvents.some((event) =>
            event.received.includes("hello bob after your send"),
          ),
        ).toBe(true);
        expect(
          watchEvents.find((event) => event.watchStatus === "errored"),
        ).toBeUndefined();
        expect(watchEvents.flatMap((event) => event.issues)).not.toContain(
          "Desired gen in the past",
        );
      } finally {
        unsubscribe();
      }
    } finally {
      await server.transport.close();
    }
  });

  test("returns watched groups to idle on explicit unwatch without emitting errored", async () => {
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

      const statusEvents: Array<{ watchStatus: string; error?: string }> = [];
      const unsubscribe = bob.onWatchEvent((event) => {
        statusEvents.push({
          watchStatus: event.watchStatus,
          error: event.error,
        });
      });

      try {
        await bob.watchGroup("demo");
        await waitForCondition(() => bob.getWatchStatus("demo") === "watching");

        await bob.unwatchGroup("demo");

        expect(bob.getWatchStatus("demo")).toBe("idle");
        expect(statusEvents.map((event) => event.watchStatus)).toContain(
          "idle",
        );
        expect(
          statusEvents.find((event) => event.watchStatus === "errored"),
        ).toBeUndefined();
      } finally {
        unsubscribe();
      }
    } finally {
      await server.transport.close();
    }
  });

  test("watch mode processes remote removal without hanging and stops further sends", async () => {
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

      await alice.createGroup("demo", { keyPackageAlias: "alice-main" });
      const invitation = await alice.addMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await bob.fetchWelcomes();
      await bob.acceptWelcome(invitation.keyPackageReference, "demo");
      await bob.watchGroup("demo");
      await waitForCondition(() => bob.getWatchStatus("demo") === "watching");

      await alice.sendMessage("demo", "before-remove");
      await waitForCondition(() =>
        bob
          .listMessages("demo")
          .some((message) => message.content === "before-remove"),
      );

      await alice.removeMember("demo", bob.stablePubkey);
      await alice.syncGroup("demo");

      await waitForCondition(() => bob.getGroup("demo").status === "removed");
      await waitForCondition(() => bob.getWatchStatus("demo") === "idle");

      await expect(
        bob.sendMessage("demo", "after-remove-watch"),
      ).rejects.toBeInstanceOf(RemovedFromGroupError);
    } finally {
      await Promise.allSettled(
        sessions.splice(0).map((session) => session.disconnect()),
      );
      await server.transport.close();
    }
  });

  test("disconnect tears down active watches cleanly", async () => {
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

      await bob.watchGroup("demo");
      await waitForCondition(() => bob.getWatchStatus("demo") === "watching");

      await expect(bob.disconnect()).resolves.toBeUndefined();
      expect(bob.getWatchStatus("demo")).toBe("idle");

      const index = sessions.indexOf(bob);
      if (index >= 0) {
        sessions.splice(index, 1);
      }
    } finally {
      await server.transport.close();
    }
  });

  test("emits semantic group events for watch status and message ingestion", async () => {
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

      const events: Array<string> = [];
      const unsubscribe = bob.onGroupEvent((event) => {
        if (event.type === "watch-status-changed") {
          events.push(`status:${event.watchStatus}`);
          return;
        }

        if (event.received.length > 0) {
          events.push(
            `received:${event.received.map((message) => message.content).join(",")}`,
          );
        }
      });

      try {
        await bob.watchGroup("demo");
        await waitForCondition(() => bob.getWatchStatus("demo") === "watching");

        await alice.sendMessage("demo", "semantic-event-check");

        await waitForCondition(() =>
          events.includes("received:semantic-event-check"),
        );

        expect(events).toContain("status:connecting");
        expect(events).toContain("status:watching");
        expect(events).toContain("received:semantic-event-check");
      } finally {
        unsubscribe();
      }
    } finally {
      await server.transport.close();
    }
  });

  test("watch mode does not report stale-generation issues when sending before older inbound traffic is replayed", async () => {
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

      await alice.sendMessage("demo", "hey");

      const watchIssues: string[] = [];
      const unsubscribe = bob.onWatchEvent((event) => {
        watchIssues.push(...event.issues.map((issue) => issue.detail));
      });

      try {
        await bob.watchGroup("demo");
        await waitForCondition(() => bob.getWatchStatus("demo") === "watching");

        await bob.sendMessage("demo", "hey");

        await waitForCondition(() =>
          bob.listMessages("demo").some((message) => message.content === "hey"),
        );

        expect(watchIssues).not.toContain("Desired gen in the past");
        expect(bob.listSyncIssues("demo")).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ detail: "Desired gen in the past" }),
          ]),
        );
      } finally {
        unsubscribe();
      }
    } finally {
      await server.transport.close();
    }
  });

  test("watch mode drains a multi-message backlog before a local send without stale-generation issues", async () => {
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

      await alice.sendMessage("demo", "alice-backlog-1");
      await alice.sendMessage("demo", "alice-backlog-2");
      await alice.sendMessage("demo", "alice-backlog-3");

      const watchIssues: string[] = [];
      const unsubscribe = bob.onWatchEvent((event) => {
        watchIssues.push(...event.issues.map((issue) => issue.detail));
      });

      try {
        await bob.watchGroup("demo");
        await waitForCondition(() => bob.getWatchStatus("demo") === "watching");

        await waitForCondition(() =>
          ["alice-backlog-1", "alice-backlog-2", "alice-backlog-3"].every(
            (content) =>
              bob
                .listMessages("demo")
                .some(
                  (message) =>
                    message.direction === "inbound" &&
                    message.content === content,
                ),
          ),
        );

        await bob.sendMessage("demo", "bob-after-backlog");
        await alice.syncGroup("demo");
        await alice.sendMessage("demo", "alice-after-bob-send");

        await waitForCondition(() =>
          bob
            .listMessages("demo")
            .some(
              (message) =>
                message.direction === "inbound" &&
                message.content === "alice-after-bob-send",
            ),
        );

        expect(watchIssues).not.toContain("Desired gen in the past");
        expect(
          bob
            .listMessages("demo")
            .filter((message) => message.direction === "inbound")
            .map((message) => message.content),
        ).toEqual([
          "alice-backlog-1",
          "alice-backlog-2",
          "alice-backlog-3",
          "alice-after-bob-send",
        ]);
      } finally {
        unsubscribe();
      }
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

      expect(alice.listSyncIssues("demo")).toEqual([]);
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

      expect(concurrentSends.map((message) => message.content)).toEqual([
        "alice-concurrent-1",
        "bob-concurrent-1",
      ]);

      expect(await carol.fetchWelcomes()).toEqual([]);
      expect(await dave.fetchWelcomes()).toEqual([]);

      const aliceCursorBeforeSync = alice.getGroup("demo").fetchCursor;
      const bobCursorBeforeSync = bob.getGroup("demo").fetchCursor;

      const aliceRoundOne = await alice.syncGroup("demo");
      const bobRoundOne = await bob.syncGroup("demo");

      expect(aliceRoundOne.map((message) => message.content)).toEqual(
        expect.arrayContaining(["bob-concurrent-1"]),
      );
      expect(bobRoundOne.map((message) => message.content)).toEqual(
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
        ...carol.listWelcomes().map((welcome) => welcome.kp_ref),
        ...dave.listWelcomes().map((welcome) => welcome.kp_ref),
      ];

      expect(deliveredRefs).toHaveLength(2);
      expect(deliveredRefs).toEqual(
        expect.arrayContaining([
          carolInvitation.keyPackageReference,
          daveInvitation.keyPackageReference,
        ]),
      );

      const carolJoined =
        carol
          .listWelcomes()
          .find(
            (welcome) => welcome.kp_ref === carolInvitation.keyPackageReference,
          ) !== undefined;

      expect(carolJoined).toBe(true);

      await carol.acceptWelcome(carolInvitation.keyPackageReference, "demo");
      await dave.acceptWelcome(daveInvitation.keyPackageReference, "demo");

      const survivor = carol;
      const survivorName = "carol";
      const rejectedName = "dave";
      const rejectedSession = dave;

      expect(alice.listSyncIssues("demo")).toEqual([]);
      expect(bob.listSyncIssues("demo")).toEqual([]);

      await alice.sendMessage(
        "demo",
        `post-reconcile-from-alice-to-${survivorName}`,
      );
      await bob.sendMessage(
        "demo",
        `post-reconcile-from-bob-to-${survivorName}`,
      );

      const survivorMessages = await survivor.syncGroup("demo");

      expect(survivorMessages.map((message) => message.content)).toEqual([
        `post-reconcile-from-alice-to-${survivorName}`,
        `post-reconcile-from-bob-to-${survivorName}`,
      ]);
      expect(
        survivor.listMessages("demo").map((message) => message.content),
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
      expect(aliceHistory.map((message) => message.content)).toEqual(
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

      expect(erinMessages.map((message) => message.content)).toEqual([
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
        (await alice.syncGroup("demo")).map((message) => message.content),
      ).toEqual(expect.arrayContaining([`welcome-erin-via-${survivorName}`]));
      expect(
        (await bob.syncGroup("demo")).map((message) => message.content),
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
          kp_ref: recoveryInvitation.keyPackageReference,
        }),
      ]);
      await rejectedSession.acceptWelcome(
        recoveryInvitation.keyPackageReference,
        "demo-recovery",
      );

      await bob.sendMessage("demo", `reinvited-${rejectedName}-hello`);
      const recoveredMessages =
        await rejectedSession.syncGroup("demo-recovery");

      expect(recoveredMessages.map((message) => message.content)).toEqual([
        `reinvited-${rejectedName}-hello`,
      ]);
      expect(rejectedSession.listGroups()).toHaveLength(2);

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
            (welcome) => welcome.kp_ref === carolInvitation.keyPackageReference,
          );
        const daveCanJoin = dave
          .listWelcomes()
          .some(
            (welcome) => welcome.kp_ref === daveInvitation.keyPackageReference,
          );

        expect(Number(carolCanJoin) + Number(daveCanJoin)).toBe(2);

        await carol.acceptWelcome(carolInvitation.keyPackageReference, "demo");
        await dave.acceptWelcome(daveInvitation.keyPackageReference, "demo");

        expect(await carol.fetchWelcomes()).toEqual([]);
        expect(await dave.fetchWelcomes()).toEqual([]);

        const survivor = carol;

        for (const session of [alice, bob, survivor]) {
          await session.syncGroup("demo");
          await session.syncGroup("demo");
        }

        const issueDetails = [
          ...alice.listSyncIssues("demo"),
          ...bob.listSyncIssues("demo"),
        ].map((issue) => issue.detail);

        expect(issueDetails).toEqual([]);

        await alice.sendMessage("demo", "post-order-alice");
        await bob.sendMessage("demo", "post-order-bob");
        const survivorReceived = await survivor.syncGroup("demo");

        expect(survivorReceived.map((message) => message.content)).toEqual([
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
          kp_ref: carolIntoA.keyPackageReference,
        }),
      ]);
      expect(dave.listWelcomes()).toEqual([
        expect.objectContaining({
          kp_ref: daveIntoB.keyPackageReference,
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
          kp_ref: erinIntoA.keyPackageReference,
        }),
      ]);
      expect(
        carol
          .listWelcomes()
          .map((welcome) => welcome.kp_ref)
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

      expect(erinReceived.map((message) => message.content)).toEqual([
        "group-a-post-join",
      ]);
      expect(carolGroupBReceived.map((message) => message.content)).toEqual([
        "group-b-post-join",
      ]);

      expect(alice.listSyncIssues("group-a")).toEqual([]);
      expect(alice.listSyncIssues("group-b")).toEqual([]);
      expect(bob.listSyncIssues("group-a")).toEqual([]);
      expect(bob.listSyncIssues("group-b")).toEqual([]);

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
          session.listMessages(alias).map((message) => message.content),
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

  test("per-group serialization does not block independent group progress during syncAll", async () => {
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
      await bob.generateKeyPackage("bob-a");
      await bob.generateKeyPackage("bob-b");
      await bob.publishKeyPackage("bob-a");
      await bob.publishKeyPackage("bob-b");

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

      await bob.watchGroup("group-a");
      await waitForCondition(
        () => bob.getWatchStatus("group-a") === "watching",
      );

      await alice.sendMessage("group-a", "a-backlog-1");
      await alice.sendMessage("group-a", "a-backlog-2");
      await alice.sendMessage("group-b", "b-independent-1");

      await waitForCondition(() =>
        bob
          .listMessages("group-a")
          .some((message) => message.content === "a-backlog-2"),
      );

      const synced = await bob.syncAll();

      expect(synced["group-a"]).toEqual([]);
      expect(synced["group-b"]?.map((message) => message.content)).toEqual([
        "b-independent-1",
      ]);
      expect(bob.listSyncIssues("group-a")).toEqual([]);
      expect(bob.listSyncIssues("group-b")).toEqual([]);
    } finally {
      await server.transport.close();
    }
  });

  test("completed group operations do not retain queue entries", async () => {
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

      await alice.sendMessage("demo", "first");
      await bob.syncGroup("demo");
      await bob.sendMessage("demo", "second");
      await alice.syncGroup("demo");

      const queue = (
        alice as unknown as { groupOperations: Map<string, Promise<void>> }
      ).groupOperations;

      expect(queue.size).toBe(0);
      expect(queue.has("demo")).toBe(false);
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
          .some((welcome) => welcome.kp_ref === carolIntoA.keyPackageReference),
        dave
          .listWelcomes()
          .some((welcome) => welcome.kp_ref === daveIntoA.keyPackageReference),
      ];
      const acceptedB = [
        erin
          .listWelcomes()
          .some((welcome) => welcome.kp_ref === erinIntoB.keyPackageReference),
        frank
          .listWelcomes()
          .some((welcome) => welcome.kp_ref === frankIntoB.keyPackageReference),
      ];

      expect(acceptedA.filter(Boolean)).toHaveLength(2);
      expect(acceptedB.filter(Boolean)).toHaveLength(2);

      const survivorA = carol;
      const survivorAAlias = "carol-a";
      const survivorB = erin;
      const survivorBAlias = "erin-b";

      await carol.acceptWelcome(carolIntoA.keyPackageReference, "group-a");
      await dave.acceptWelcome(daveIntoA.keyPackageReference, "group-a");

      await erin.acceptWelcome(erinIntoB.keyPackageReference, "group-b");
      await frank.acceptWelcome(frankIntoB.keyPackageReference, "group-b");

      expect(await dave.fetchWelcomes()).toEqual([]);
      expect(await frank.fetchWelcomes()).toEqual([]);

      await alice.sendMessage("group-a", `group-a-post-${survivorAAlias}`);
      await bob.sendMessage("group-b", `group-b-post-${survivorBAlias}`);

      const survivorAReceived = await survivorA.syncGroup("group-a");
      const survivorBReceived = await survivorB.syncGroup("group-b");

      expect(survivorAReceived.map((message) => message.content)).toEqual([
        `group-a-post-${survivorAAlias}`,
      ]);
      expect(survivorBReceived.map((message) => message.content)).toEqual([
        `group-b-post-${survivorBAlias}`,
      ]);

      expect(
        survivorA.listMessages("group-a").map((message) => message.content),
      ).not.toContain(`group-b-post-${survivorBAlias}`);
      expect(
        survivorB.listMessages("group-b").map((message) => message.content),
      ).not.toContain(`group-a-post-${survivorAAlias}`);

      expect(alice.listSyncIssues("group-a")).toEqual([]);
      expect(bob.listSyncIssues("group-b")).toEqual([]);

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

      expect(dave.listMessages("group-a")).toEqual([]);
      expect(frank.listMessages("group-b")).toEqual([]);
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
        bobBootstrap["group-a"]?.map((message) => message.content),
      ).toEqual(["a-bootstrap-1"]);
      expect(
        bobBootstrap["group-b"]?.map((message) => message.content),
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
        aliceRoundOne["group-a"]?.map((message) => message.content),
      ).toEqual(expect.arrayContaining(["a-round-1-from-bob"]));
      expect(bobRoundOne["group-b"]?.map((message) => message.content)).toEqual(
        expect.arrayContaining(["b-round-1-from-alice"]),
      );

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
        erinJoinedSync["group-a-erin"]?.map((message) => message.content),
      ).toEqual(["a-post-erin-join"]);
      expect(
        carolSecondJoinedSync["group-b-carol"]?.map(
          (message) => message.content,
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
        carolRejoinSync["group-a-rejoin"]?.map((message) => message.content),
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
        frankJoinedSync["group-a-frank"]?.map((message) => message.content),
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
        daveRejoinSync["group-b-rejoin"]?.map((message) => message.content),
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

      expect(aliceDrain["group-a"] ?? []).toEqual([]);
      expect(bobDrain["group-b"] ?? []).toEqual([]);
      expect(
        carolDrain["group-a-rejoin"]?.map((message) => message.content),
      ).toEqual(expect.arrayContaining(["a-post-frank-join"]));
      expect(daveDrain["group-b-rejoin"] ?? []).toEqual([]);
      expect(
        erinDrain["group-a-erin"]?.map((message) => message.content),
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
          .map((message) => message.content);
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

      expect(conversation.synced.map((message) => message.content)).toEqual([
        "welcome carol",
        "glad you joined",
      ]);
      expect(conversation.synced.map((message) => message.sender)).toEqual([
        alice.stablePubkey,
        bob.stablePubkey,
      ]);
      expect(conversation.messages.map((message) => message.content)).toEqual([
        "welcome carol",
        "glad you joined",
      ]);
    } finally {
      await server.transport.close();
    }
  });
});
