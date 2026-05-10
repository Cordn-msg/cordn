import { beforeEach, describe, expect, test, vi } from "vitest";

const { processMessageBase64 } = vi.hoisted(() => ({
  processMessageBase64: vi.fn(),
}));

vi.mock("./utils/mlsMessages.ts", () => ({
  processMessageBase64,
  decodeApplicationData: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
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

  test("reconciles self-echoed outbound messages by ciphertext identity", async () => {
    const group = createGroupState();
    const outbound = {
      cursor: 0,
      createdAt: 50,
      direction: "outbound" as const,
      sender: "alice",
      plaintext: "hello",
      opaqueMessageBase64: "cipher-1",
    };
    group.messages.push(outbound);

    const result = await ingestGroupMessages({
      group,
      messages: [
        {
          cursor: 7,
          createdAt: 70,
          opaqueMessageBase64: "cipher-1",
        },
      ],
      hasPendingEpochOperation: () => false,
    });

    expect(result.received).toEqual([]);
    expect(result.reconciled).toEqual([outbound]);
    expect(outbound.cursor).toBe(7);
    expect(outbound.createdAt).toBe(70);
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
});
