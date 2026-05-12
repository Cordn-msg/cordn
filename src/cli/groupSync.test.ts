import { beforeEach, describe, expect, test, vi } from "vitest";
import { getEventHash, type UnsignedEvent } from "nostr-tools";

const { processMessageBase64 } = vi.hoisted(() => ({
  processMessageBase64: vi.fn(),
}));

vi.mock("./utils/mlsMessages.ts", () => ({
  processMessageBase64,
  decodeAuthenticatedSender: (bytes: Uint8Array) =>
    new TextDecoder().decode(bytes),
}));

vi.mock("./groupMetadata.ts", () => ({
  getCordnGroupMetadataExtension: () => undefined,
}));

import { ingestGroupMessages } from "./groupSync.ts";
import type { GroupSessionState } from "./sessionState.ts";

function createGroupState(): GroupSessionState {
  return {
    alias: "demo",
    coordinatorKey: "demo-coordinator",
    state: {} as GroupSessionState["state"],
    metadata: undefined,
    lastCursor: 0,
    fetchCursor: 0,
    messages: [],
    syncIssues: [],
  };
}

describe("ingestGroupMessages", () => {
  beforeEach(() => {
    processMessageBase64.mockReset();
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
      hasPendingEpochOperation: () => false,
    });

    expect(result.received).toEqual([]);
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
      hasPendingEpochOperation: () => true,
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
      hasPendingEpochOperation: () => false,
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
        hasPendingEpochOperation: () => false,
      }),
    ).rejects.toThrow("Cordn message envelope pubkey does not match sender");
  });
});
