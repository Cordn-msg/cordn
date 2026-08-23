import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { loadEncryptedState, saveEncryptedState } from "./localState.ts";

describe("encrypted local state", () => {
  test("round-trips state without storing plaintext and protects the key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cordn-state-"));
    const statePath = join(directory, "session.json");
    const keyPath = join(directory, "session.key");
    const value = { privateKey: "not-plaintext", cursor: 42 };

    await saveEncryptedState(statePath, keyPath, value);

    expect(await loadEncryptedState(statePath, keyPath)).toEqual(value);
    expect(await readFile(statePath, "utf8")).not.toContain(value.privateKey);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  test("rejects tampered ciphertext", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cordn-state-"));
    const statePath = join(directory, "session.json");
    const keyPath = join(directory, "session.key");
    await saveEncryptedState(statePath, keyPath, { cursor: 1 });

    const envelope = JSON.parse(await readFile(statePath, "utf8"));
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    await writeFile(statePath, JSON.stringify(envelope));

    await expect(loadEncryptedState(statePath, keyPath)).rejects.toThrow();
  });

  test("supports concurrent atomic saves", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cordn-state-"));
    const statePath = join(directory, "session.json");
    const keyPath = join(directory, "session.key");

    await saveEncryptedState(statePath, keyPath, { cursor: -1 });
    await Promise.all(
      Array.from({ length: 10 }, (_, cursor) =>
        saveEncryptedState(statePath, keyPath, { cursor }),
      ),
    );

    const restored = await loadEncryptedState<{ cursor: number }>(
      statePath,
      keyPath,
    );
    expect(restored?.cursor).toBeGreaterThanOrEqual(0);
    expect(restored?.cursor).toBeLessThan(10);
  });
});
