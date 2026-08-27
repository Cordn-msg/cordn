import { describe, expect, test } from "vitest";

import { CLI_DOC_TOPICS, readCliDoc } from "./docs.ts";

describe("bundled CLI docs", () => {
  test("loads every advertised topic", async () => {
    const docs = await Promise.all(
      CLI_DOC_TOPICS.map((topic) => readCliDoc(topic)),
    );

    expect(docs).toHaveLength(5);
    expect(docs.every((content) => content.startsWith("# "))).toBe(true);
  });

  test("loads the index without a topic", async () => {
    await expect(readCliDoc()).resolves.toContain("cordn docs quickstart");
  });

  test("rejects unknown topics with the available list", async () => {
    await expect(readCliDoc("missing")).rejects.toThrow(
      "available topics: quickstart, agent, daemon, queues, security",
    );
  });
});
