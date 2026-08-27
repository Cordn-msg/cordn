import { describe, expect, test, vi } from "vitest";

import {
  confirmPendingEpochOperations,
  dropPendingAddMemberForTarget,
  enqueuePendingEpochOperation,
  type PendingEpochOperation,
} from "./pendingEpochOperations.ts";

describe("pending epoch operations", () => {
  test("retries a confirmed Welcome finalizer after a transient failure", async () => {
    const pending = new Map<string, PendingEpochOperation[]>();
    enqueuePendingEpochOperation(pending, {
      kind: "add-member",
      groupAlias: "office",
      groupId: "gid",
      commitMessageBase64: "commit",
      keyPackageReference: "kp-ref",
      targetStablePubkey: "bob",
      welcomeBase64: "welcome",
      status: "pending",
    });
    const StoreWelcome = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ at: 1 });
    const client = { StoreWelcome } as never;

    await expect(
      confirmPendingEpochOperations(pending, client, {
        groupAlias: "office",
        opaqueMessageBase64s: ["commit"],
      }),
    ).rejects.toThrow("offline");
    expect(pending.get("office")?.[0]?.status).toBe("confirmed");

    await expect(
      confirmPendingEpochOperations(pending, client, {
        groupAlias: "office",
        opaqueMessageBase64s: [],
      }),
    ).resolves.toBe(1);
    expect(pending.has("office")).toBe(false);
  });

  test("drops only a stale add Welcome when that target is removed", () => {
    const pending = new Map<string, PendingEpochOperation[]>();
    enqueuePendingEpochOperation(pending, {
      kind: "add-member",
      groupAlias: "office",
      groupId: "gid",
      commitMessageBase64: "add",
      keyPackageReference: "kp-ref",
      targetStablePubkey: "bob",
      welcomeBase64: "welcome",
      status: "pending",
    });
    enqueuePendingEpochOperation(pending, {
      kind: "remove-member",
      groupAlias: "office",
      groupId: "gid",
      commitMessageBase64: "remove",
      targetStablePubkey: "bob",
      status: "pending",
    });

    dropPendingAddMemberForTarget(pending, "office", "bob");

    expect(pending.get("office")?.map((operation) => operation.kind)).toEqual([
      "remove-member",
    ]);
  });
});
