import { describe, expect, test, vi } from "vitest";

import { CliSession } from "./session.ts";
import { type CliSessionStore, welcomeIdentifier } from "./sessionStore.ts";
import { enqueuePendingEpochOperation } from "./pendingEpochOperations.ts";
import type { CoordinatorClientRegistry } from "./coordinatorRegistry.ts";

/** Private-store access for unit tests that drive coordinator ack state
 *  without a live coordinator. */
function storeOf(session: CliSession): CliSessionStore {
  return (session as unknown as { store: CliSessionStore }).store;
}

describe("CLI session snapshots", () => {
  const serverPubkey = "11".repeat(32);

  test("restores identity, coordinator config, and private KeyPackage state", async () => {
    const relays = ["ws://relay.example"];
    const original = new CliSession({ serverPubkey, relays });
    await original.generateKeyPackage("writer", {
      localOnly: true,
      lastResort: true,
    });
    const snapshot = original.exportSnapshot();
    const restored = new CliSession({
      privateKey: original.privateKey,
      serverPubkey,
      relays,
    });

    await restored.restoreSnapshot(snapshot);

    expect(restored.stablePubkey).toBe(original.stablePubkey);
    expect(snapshot.defaultCoordinator).toEqual({ serverPubkey, relays });
    expect(restored.listKeyPackages()).toMatchObject([
      {
        alias: "writer",
        keyPackageRef: original.listKeyPackages()[0]?.keyPackageRef,
        isLastResort: true,
        consumed: false,
      },
    ]);
    expect(restored.exportSnapshot()).toEqual(snapshot);
    await Promise.all([original.disconnect(), restored.disconnect()]);
  });

  test("restores pending epoch operations and coordinator ack state", async () => {
    const original = new CliSession({ serverPubkey });
    const store = storeOf(original);
    const acceptedWelcome = {
      kp_ref: "ref",
      welcome_64: "w",
      at: 1,
      coordinatorKey: serverPubkey,
    };
    store.putWelcome(acceptedWelcome);
    store.deleteWelcome(welcomeIdentifier(acceptedWelcome), serverPubkey);
    store.setFetchedJoinRequests("gid", [
      {
        requesterStablePubkey: "pk",
        keyPackageReference: "ref",
        createdAt: 2,
      },
    ]);
    store.queueConsumedJoinRequest("gid", {
      requesterStablePubkey: "pk",
      createdAt: 2,
    });
    enqueuePendingEpochOperation(store.pendingOperations, {
      kind: "add-member",
      groupAlias: "office",
      groupId: "gid",
      commitMessageBase64: "commit",
      keyPackageReference: "ref",
      targetStablePubkey: "pk",
      welcomeBase64: "welcome",
      status: "pending",
    });

    const snapshot = original.exportSnapshot();
    const restored = new CliSession({
      privateKey: original.privateKey,
      serverPubkey,
    });
    await restored.restoreSnapshot(snapshot);

    const restoredStore = storeOf(restored);
    // Accepted IDs survive, so the same record cannot be re-added.
    restoredStore.putWelcome(acceptedWelcome);
    expect(restoredStore.listWelcomes()).toEqual([]);
    expect(restoredStore.peekConsumedWelcomes(serverPubkey)).toEqual([
      { keyPackageReference: "ref", createdAt: 1 },
    ]);
    expect(restoredStore.findFetchedJoinRequest("gid", "pk", "ref")).toEqual({
      requesterStablePubkey: "pk",
      keyPackageReference: "ref",
      createdAt: 2,
    });
    expect(restoredStore.peekConsumedJoinRequests("gid")).toEqual([
      { requesterStablePubkey: "pk", createdAt: 2 },
    ]);
    expect(restoredStore.pendingOperations.get("office")).toEqual(
      snapshot.pendingEpochOperations?.["office"],
    );
    expect(restored.exportSnapshot()).toEqual(snapshot);
    await Promise.all([original.disconnect(), restored.disconnect()]);
  });

  test("collapses legacy duplicate aliases for one group ID", async () => {
    const original = new CliSession({ serverPubkey });
    await original.generateKeyPackage("writer", { localOnly: true });
    await original.createGroup("demo", { keyPackageAlias: "writer" });
    const snapshot = original.exportSnapshot();
    const duplicate = {
      ...snapshot.groups[0]!,
      alias: "demo-recovery",
      lastCursor: 3,
      fetchCursor: 3,
      messages: [
        {
          cursor: 3,
          createdAt: 1,
          direction: "inbound" as const,
          sender: "sender",
          id: "message",
          kind: 9,
          tags: [],
          content: "recovered",
        },
      ],
    };
    snapshot.groups.push(duplicate);
    snapshot.pendingEpochOperations = {
      "demo-recovery": [
        {
          kind: "update-group-metadata",
          groupAlias: "demo-recovery",
          groupId: original.deriveGroupId(original.getGroup("demo").state),
          commitMessageBase64: "commit",
          status: "pending",
        },
      ],
    };
    const restored = new CliSession({
      privateKey: original.privateKey,
      serverPubkey,
    });

    await restored.restoreSnapshot(snapshot);

    expect(restored.listGroups().map((group) => group.alias)).toEqual(["demo"]);
    expect(restored.getGroup("demo").fetchCursor).toBe(3);
    expect(
      restored.listMessages("demo").map((message) => message.content),
    ).toEqual(["recovered"]);
    expect(
      storeOf(restored).pendingOperations.get("demo")?.[0]?.groupAlias,
    ).toBe("demo");
    await Promise.all([original.disconnect(), restored.disconnect()]);
  });

  test("keeps local KeyPackage material when remote deletion fails", async () => {
    const session = new CliSession({ serverPubkey });
    await session.generateKeyPackage("writer", { localOnly: true });
    const registry = (
      session as unknown as { coordinatorRegistry: CoordinatorClientRegistry }
    ).coordinatorRegistry;
    vi.spyOn(registry, "getClient").mockReturnValue({
      RemoveKeyPackages: vi.fn().mockRejectedValue(new Error("offline")),
    } as never);

    await expect(session.deleteKeyPackage("writer")).rejects.toThrow("offline");
    expect(session.listKeyPackages().map((entry) => entry.alias)).toEqual([
      "writer",
    ]);
    await session.disconnect();
  });

  test("rejects a snapshot belonging to another identity", async () => {
    const original = new CliSession({ serverPubkey });
    const other = new CliSession({ serverPubkey });

    await expect(
      other.restoreSnapshot(original.exportSnapshot()),
    ).rejects.toThrow("snapshot identity does not match CLI identity");
    await Promise.all([original.disconnect(), other.disconnect()]);
  });
});
