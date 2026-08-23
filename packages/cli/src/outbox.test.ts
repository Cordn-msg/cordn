import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { processOutbox } from "./outbox.ts";

describe("persistent outbox", () => {
  test("sends jobs in filename order and removes successful jobs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cordn-outbox-"));
    await writeFile(
      join(directory, "002.json"),
      JSON.stringify({ message: "two" }),
    );
    await writeFile(
      join(directory, "001.json"),
      JSON.stringify({ groupAlias: "other", message: "one" }),
    );
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 1 })
      .mockResolvedValueOnce({ cursor: 2 });
    const persist = vi.fn();

    await processOutbox(
      directory,
      { sendMessage },
      {
        defaultGroupAlias: "default",
        persist,
      },
    );

    expect(sendMessage.mock.calls).toEqual([
      ["other", "one"],
      ["default", "two"],
    ]);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(await readdir(directory)).toEqual([]);
  });

  test("puts a failed job back for retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cordn-outbox-"));
    const jobPath = join(directory, "001.json");
    await writeFile(jobPath, JSON.stringify({ message: "retry" }));
    const sender = {
      sendMessage: vi.fn().mockRejectedValue(new Error("offline")),
    };

    await expect(
      processOutbox(directory, sender, { defaultGroupAlias: "group" }),
    ).rejects.toThrow("offline");

    expect(JSON.parse(await readFile(jobPath, "utf8"))).toEqual({
      message: "retry",
    });
    expect(await readdir(directory)).toEqual(["001.json"]);
  });
});
