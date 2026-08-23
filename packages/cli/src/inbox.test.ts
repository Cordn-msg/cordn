import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { enqueueInboundMessages } from "./inbox.ts";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  ),
);

describe("inbound message queue", () => {
  test("atomically queues only inbound group messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cordn-inbox-"));
    directories.push(directory);
    const base = {
      createdAt: 123,
      sender: "a".repeat(64),
      id: "b".repeat(64),
      kind: 9,
      tags: [],
      content: "hello",
    };

    await enqueueInboundMessages(directory, "office", [
      { ...base, cursor: 7, direction: "inbound" },
      { ...base, cursor: 8, direction: "outbound" },
    ]);

    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^0{15}7-.+\.json$/);
    expect(
      JSON.parse(await readFile(join(directory, files[0]!), "utf8")),
    ).toMatchObject({
      groupAlias: "office",
      cursor: 7,
      sender: "a".repeat(64),
      content: "hello",
    });
  });
});
