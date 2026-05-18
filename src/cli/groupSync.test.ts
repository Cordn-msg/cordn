import { beforeEach, describe, expect, test, vi } from "vitest";
import { getEventHash, type UnsignedEvent } from "nostr-tools";

const { processMessageBase64 } = vi.hoisted(() => ({
  processMessageBase64: vi.fn(),
}));

const { findMemberLeafIndexByStablePubkey } = vi.hoisted(() => ({
  findMemberLeafIndexByStablePubkey: vi.fn(),
}));

vi.mock("./utils/mlsMessages.ts", () => ({
  processMessageBase64,
  decodeAuthenticatedSender: (bytes: Uint8Array) =>
    new TextDecoder().decode(bytes),
}));

vi.mock("./groupMetadata.ts", () => ({
  getCordnGroupMetadataExtension: () => undefined,
}));

vi.mock("./utils/mlsGroupLifecycle.ts", () => ({
  findMemberLeafIndexByStablePubkey,
}));

import { ingestGroupMessages } from "./groupSync.ts";
import type { GroupSessionState } from "./sessionState.ts";

function createGroupState(): GroupSessionState {
  return {
    alias: "demo",
    coordinatorKey: "demo-coordinator",
    state: {} as GroupSessionState["state"],
    metadata: undefined,
    status: "active",
    lastCursor: 0,
    fetchCursor: 0,
    messages: [],
    syncIssues: [],
  };
}

describe("ingestGroupMessages", () => {
  beforeEach(() => {
    processMessageBase64.mockReset();
    findMemberLeafIndexByStablePubkey.mockReset();
    findMemberLeafIndexByStablePubkey.mockReturnValue(0);
  });

  test("skips self-echoed outbound messages by cursor", async () => {
    const group = createGroupState();
    const outbound = {
      cursor: 7,
      createdAt: 50,
      direction: "outbound" as const,
      sender: "alice",
      id: "event-1",
      kind: 9,
      tags: [],
      content: "hello",
    };
    group.messages.push(outbound);

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 7,
          createdAt: 70,
          opaqueMessageBase64: "different-ciphertext",
        },
      ],
      getPendingEpochOperation: () => undefined,
      localStablePubkey: "alice",
    });

    expect(result.received).toEqual([]);
    expect(group.fetchCursor).toBe(7);
    expect(group.lastCursor).toBe(7);
  });

  test("does not skip self-echoed pending epoch operations by cursor", async () => {
    const group = createGroupState();
    group.messages.push({
      cursor: 7,
      createdAt: 50,
      direction: "outbound",
      sender: "alice",
      id: "event-1",
      kind: 9,
      tags: [],
      content: "hello",
    });

    processMessageBase64.mockResolvedValueOnce({
      kind: "newState",
      newState: {
        ...group.state,
        next: true,
        groupActiveState: { kind: "active" },
      } as unknown as GroupSessionState["state"],
    });

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 7,
          createdAt: 70,
          opaqueMessageBase64: "pending-commit",
        },
      ],
      getPendingEpochOperation: (opaqueMessageBase64) =>
        opaqueMessageBase64 === "pending-commit"
          ? {
              kind: "add-member",
              groupAlias: "demo",
              groupId: "gid",
              commitMessageBase64: "pending-commit",
              keyPackageReference: "kp-ref",
              targetStablePubkey: "bob",
              welcomeBase64: "welcome",
              status: "pending",
            }
          : undefined,
      localStablePubkey: "alice",
    });

    expect(processMessageBase64).toHaveBeenCalledTimes(1);
    expect(result.appliedPendingCommitMessages).toEqual(
      new Set(["pending-commit"]),
    );
    expect(group.fetchCursor).toBe(7);
    expect(group.lastCursor).toBe(7);
  });

  test("records stale-epoch issues and advances fetch progress", async () => {
    const group = createGroupState();

    processMessageBase64.mockRejectedValueOnce(
      new Error("Cannot process commit or proposal from former epoch"),
    );

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 4,
          createdAt: 40,
          opaqueMessageBase64: "stale-commit",
        },
      ],
      getPendingEpochOperation: () => ({
        kind: "add-member",
        groupAlias: "demo",
        groupId: "gid",
        commitMessageBase64: "stale-commit",
        keyPackageReference: "kp-ref",
        targetStablePubkey: "bob",
        welcomeBase64: "welcome",
        status: "pending",
      }),
      localStablePubkey: "alice",
    });

    expect(result.issues).toEqual([
      {
        cursor: 4,
        createdAt: 40,
        detail: "Cannot process commit or proposal from former epoch",
      },
    ]);
    expect(result.rejectedPendingCommitMessages).toEqual(
      new Set(["stale-commit"]),
    );
    expect(group.fetchCursor).toBe(4);
    expect(group.lastCursor).toBe(4);
  });

  test("confirms pending remove-member commits that are already applied locally", async () => {
    const group = createGroupState();

    processMessageBase64.mockRejectedValueOnce(
      new Error("Could not find common ancestor"),
    );

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 4,
          createdAt: 40,
          opaqueMessageBase64: "pending-remove-commit",
        },
      ],
      getPendingEpochOperation: () => ({
        kind: "remove-member",
        groupAlias: "demo",
        groupId: "gid",
        commitMessageBase64: "pending-remove-commit",
        targetStablePubkey: "bob",
        status: "pending",
      }),
      localStablePubkey: "alice",
    });

    expect(result.issues).toEqual([]);
    expect(result.appliedPendingCommitMessages).toEqual(
      new Set(["pending-remove-commit"]),
    );
    expect(group.status).toBe("active");
  });

  test("confirms pending remove-member commits when their echo is rejected as former epoch", async () => {
    const group = createGroupState();

    processMessageBase64.mockRejectedValueOnce(
      new Error("Cannot process commit or proposal from former epoch"),
    );

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 5,
          createdAt: 50,
          opaqueMessageBase64: "pending-remove-former-epoch",
        },
      ],
      getPendingEpochOperation: () => ({
        kind: "remove-member",
        groupAlias: "demo",
        groupId: "gid",
        commitMessageBase64: "pending-remove-former-epoch",
        targetStablePubkey: "bob",
        status: "pending",
      }),
      localStablePubkey: "alice",
    });

    expect(result.issues).toEqual([]);
    expect(result.rejectedPendingCommitMessages).toEqual(new Set());
    expect(result.appliedPendingCommitMessages).toEqual(
      new Set(["pending-remove-former-epoch"]),
    );
    expect(group.status).toBe("active");
  });

  test("confirms echoed pending epoch operations after successful processing", async () => {
    const group = createGroupState();

    processMessageBase64.mockResolvedValueOnce({
      kind: "newState",
      newState: {
        ...group.state,
        next: true,
        groupActiveState: { kind: "active" },
      } as unknown as GroupSessionState["state"],
    });

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 5,
          createdAt: 50,
          opaqueMessageBase64: "pending-commit",
        },
      ],
      getPendingEpochOperation: (opaqueMessageBase64) =>
        opaqueMessageBase64 === "pending-commit"
          ? {
              kind: "add-member",
              groupAlias: "demo",
              groupId: "gid",
              commitMessageBase64: "pending-commit",
              keyPackageReference: "kp-ref",
              targetStablePubkey: "bob",
              welcomeBase64: "welcome",
              status: "pending",
            }
          : undefined,
      localStablePubkey: "alice",
    });

    expect(processMessageBase64).toHaveBeenCalledTimes(1);
    expect(result.appliedPendingCommitMessages).toEqual(
      new Set(["pending-commit"]),
    );
    expect(result.rejectedPendingCommitMessages).toEqual(new Set());
    expect(group.fetchCursor).toBe(5);
    expect(group.lastCursor).toBe(5);
  });

  test("records stale-generation issues and advances fetch progress", async () => {
    const group = createGroupState();

    processMessageBase64.mockRejectedValueOnce(
      new Error("Desired gen in the past"),
    );

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 9,
          createdAt: 90,
          opaqueMessageBase64: "late-private-message",
        },
      ],
      getPendingEpochOperation: () => undefined,
      localStablePubkey: "alice",
    });

    expect(result.issues).toEqual([
      {
        cursor: 9,
        createdAt: 90,
        detail: "Desired gen in the past",
      },
    ]);
    expect(result.received).toEqual([]);
    expect(group.fetchCursor).toBe(9);
    expect(group.lastCursor).toBe(9);
  });

  test("marks removed when commit processing fails because the local member was removed", async () => {
    const group = createGroupState();

    processMessageBase64.mockRejectedValueOnce(
      new Error("Could not find common ancestor"),
    );

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 10,
          createdAt: 100,
          opaqueMessageBase64: "removed-commit",
        },
      ],
      getPendingEpochOperation: () => undefined,
      localStablePubkey: "alice",
    });

    expect(result.removedLocalMember).toBe(true);
    expect(result.issues).toEqual([]);
    expect(group.status).toBe("removed");
    expect(group.removedAtCursor).toBe(10);
  });

  test("rejects application messages whose envelope pubkey does not match sender", async () => {
    const group = createGroupState();
    const event: UnsignedEvent = {
      pubkey:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      created_at: 1,
      kind: 9,
      tags: [],
      content: "hello",
    };

    processMessageBase64.mockResolvedValueOnce({
      kind: "applicationMessage",
      newState: group.state,
      aad: new TextEncoder().encode(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
      message: new TextEncoder().encode(
        JSON.stringify({
          ...event,
          id: getEventHash(event),
        }),
      ),
    });

    await expect(
      ingestGroupMessages({
        group,
        messages: [
          {
            cursor: 2,
            createdAt: 20,
            opaqueMessageBase64: "cipher-2",
          },
        ],
        getPendingEpochOperation: () => undefined,
        localStablePubkey:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).rejects.toThrow("Cordn message envelope pubkey does not match sender");
  });

  test("marks the local group removed when the local member is no longer present", async () => {
    const group = createGroupState();
    processMessageBase64.mockResolvedValueOnce({
      kind: "newState",
      newState: { next: true } as unknown as GroupSessionState["state"],
    });
    findMemberLeafIndexByStablePubkey.mockReturnValueOnce(-1);

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 11,
          createdAt: 110,
          opaqueMessageBase64: "remove-local-member",
        },
      ],
      getPendingEpochOperation: () => undefined,
      localStablePubkey: "alice",
    });

    expect(result.removedLocalMember).toBe(true);
    expect(group.status).toBe("removed");
    expect(group.removedAtCursor).toBe(11);
  });

  test("marks the local group removed when ts-mls returns removedFromGroup state", async () => {
    const group = createGroupState();
    processMessageBase64.mockResolvedValueOnce({
      kind: "newState",
      newState: {
        ...group.state,
        groupActiveState: { kind: "removedFromGroup" },
      } as GroupSessionState["state"],
    });

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 12,
          createdAt: 120,
          opaqueMessageBase64: "remove-local-member-stateful",
        },
      ],
      getPendingEpochOperation: () => undefined,
      localStablePubkey: "alice",
    });

    expect(result.removedLocalMember).toBe(true);
    expect(group.status).toBe("removed");
    expect(group.removedAtCursor).toBe(12);
  });

  test("records admin-policy rejections as sync issues", async () => {
    const group = createGroupState();

    processMessageBase64.mockResolvedValueOnce({
      kind: "newState",
      newState: group.state,
      actionTaken: "reject",
      consumed: [],
      aad: new Uint8Array(),
    });

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 13,
          createdAt: 130,
          opaqueMessageBase64: "unauthorized-admin-commit",
        },
      ],
      getPendingEpochOperation: () => undefined,
      localStablePubkey: "alice",
    });

    expect(result.received).toEqual([]);
    expect(result.issues).toEqual([
      {
        cursor: 13,
        createdAt: 130,
        detail: "Rejected unauthorized admin action in group demo",
      },
    ]);
    expect(group.fetchCursor).toBe(13);
    expect(group.lastCursor).toBe(13);
  });
});
