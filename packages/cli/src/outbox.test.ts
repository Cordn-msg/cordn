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

  test("quarantines invalid jobs without blocking later jobs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cordn-outbox-"));
    await writeFile(join(directory, "001.json"), "null");
    await writeFile(
      join(directory, "002.json"),
      JSON.stringify({ groupAlias: "office", message: 42 }),
    );
    await writeFile(
      join(directory, "003.json"),
      JSON.stringify({ groupAlias: 42, message: "wrong target" }),
    );
    await writeFile(
      join(directory, "004.json"),
      JSON.stringify({ groupAlias: "office", message: "ok" }),
    );
    const sendMessage = vi.fn().mockResolvedValue({ cursor: 1 });

    await processOutbox(directory, { sendMessage }, {});

    expect(sendMessage.mock.calls).toEqual([["office", "ok"]]);
    expect(await readdir(directory)).toEqual([
      "001.json.invalid",
      "002.json.invalid",
      "003.json.invalid",
    ]);
  });

  test("finishes an orphan before a new job reusing its base name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cordn-outbox-"));
    await writeFile(
      join(directory, "001.json.processing"),
      JSON.stringify({ message: "orphan" }),
    );
    await writeFile(
      join(directory, "001.json"),
      JSON.stringify({ message: "new" }),
    );
    const sendMessage = vi.fn().mockResolvedValue({ cursor: 4 });

    await processOutbox(
      directory,
      { sendMessage },
      { defaultGroupAlias: "office" },
    );

    expect(sendMessage.mock.calls).toEqual([
      ["office", "orphan"],
      ["office", "new"],
    ]);
    expect(await readdir(directory)).toEqual([]);
  });

  test("adopts a job orphaned mid-processing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cordn-outbox-"));
    await writeFile(
      join(directory, "001.json.processing"),
      JSON.stringify({ message: "resumed" }),
    );
    const sendMessage = vi.fn().mockResolvedValue({ cursor: 4 });

    await processOutbox(
      directory,
      { sendMessage },
      { defaultGroupAlias: "office" },
    );

    expect(sendMessage.mock.calls).toEqual([["office", "resumed"]]);
    expect(await readdir(directory)).toEqual([]);
  });
});
