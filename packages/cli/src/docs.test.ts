import { describe, expect, test } from "vitest";

import { CLI_DOC_TOPICS, readCliDoc } from "./docs.ts";
import { REPL_COMMAND_HELP } from "./replFormat.ts";

describe("bundled CLI docs", () => {
  test("loads every advertised topic", async () => {
    const docs = await Promise.all(
      CLI_DOC_TOPICS.map((topic) => readCliDoc(topic)),
    );

    expect(docs).toHaveLength(6);
    expect(docs.every((content) => content.startsWith("# "))).toBe(true);
  });

  test("loads the index without a topic", async () => {
    await expect(readCliDoc()).resolves.toContain("cordn docs quickstart");
  });

  test("documents every interactive command", async () => {
    const commands = await readCliDoc("commands");

    for (const { usage } of REPL_COMMAND_HELP) {
      expect(commands).toContain(usage);
    }
  });

  test("rejects unknown topics with the available list", async () => {
    await expect(readCliDoc("missing")).rejects.toThrow(
      "available topics: quickstart, commands, agent, daemon, queues, security",
    );
  });
});
