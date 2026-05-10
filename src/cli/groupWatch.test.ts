import { describe, expect, test } from "vitest";

import { runGroupWatch } from "./groupWatch.ts";

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

describe("runGroupWatch", () => {
  test("fetches first and then streams subsequent live messages", async () => {
    const seen: string[] = [];
    let releaseLiveMessage: (() => void) | undefined;
    const stream: AsyncIterable<{
      cursor: number;
      groupId: string;
      createdAt: number;
      opaqueMessageBase64: string;
    }> = {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => {
          releaseLiveMessage = resolve;
        });

        yield {
          cursor: 5,
          groupId: "demo",
          createdAt: 101,
          opaqueMessageBase64: "live-1",
        };
      },
    };

    const watch = runGroupWatch({
      client: {
        SubscribeGroupMessages: async () => ({
          stream,
          result: Promise.resolve({ subscribed: true }),
          abort: async () => undefined,
        }),
      } as never,
      groupId: "demo",
      getAfterCursor: () => 3,
      fetchMessages: async () => [
        {
          cursor: 4,
          groupId: "demo",
          createdAt: 100,
          opaqueMessageBase64: "catchup",
        },
      ],
      callbacks: {
        onConnecting: () => {
          seen.push("connecting");
        },
        onWatching: () => {
          seen.push("watching");
        },
        onMessages: async (messages) => {
          seen.push(`messages:${messages.length}`);
        },
      },
    });

    await waitForCondition(() => releaseLiveMessage !== undefined);
    releaseLiveMessage?.();
    await watch.task;

    expect(seen).toEqual([
      "connecting",
      "messages:1",
      "watching",
      "messages:1",
    ]);
  });
});
