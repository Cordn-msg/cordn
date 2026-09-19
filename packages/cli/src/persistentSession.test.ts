import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openPersistentSession } from "./persistentSession.ts";
import { createPrivateKeyHex } from "./utils/mlsBase.ts";

describe("openPersistentSession", () => {
  let dir: string;
  let stateFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cordn-persistent-session-"));
    stateFile = join(dir, "session.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates state, persists, and restores identity and key packages", async () => {
    const first = await openPersistentSession({ stateFile });
    expect(first.restored).toBe(false);
    const pubkey = first.session.stablePubkey;
    await first.session.generateKeyPackage("agent", { localOnly: true });
    await first.persist();
    await first.close();

    const files = await readdir(dir);
    expect(files).toContain("session.json");
    expect(files).toContain("session.json.key");
    expect(files).not.toContain("session.json.lock");

    const second = await openPersistentSession({ stateFile });
    expect(second.restored).toBe(true);
    expect(second.session.stablePubkey).toBe(pubkey);
    expect(second.session.listKeyPackages().map((kp) => kp.alias)).toEqual([
      "agent",
    ]);
    await second.close();
  });

  it("refuses a second writer while the state is open", async () => {
    const first = await openPersistentSession({ stateFile });
    await expect(openPersistentSession({ stateFile })).rejects.toThrow();
    await first.close();
    const again = await openPersistentSession({ stateFile });
    await again.close();
  });

  it("rejects a private key that does not match the stored identity", async () => {
    const first = await openPersistentSession({
      stateFile,
      privateKey: createPrivateKeyHex(),
    });
    await first.close();
    await expect(
      openPersistentSession({ stateFile, privateKey: createPrivateKeyHex() }),
    ).rejects.toThrow(/does not match the identity/);
    expect(await readdir(dir)).not.toContain("session.json.lock");
  });

  it("records durability failures and still releases the lock", async () => {
    const opened = await openPersistentSession({
      stateFile,
      stateKeyFile: dir, // a directory: key read/write must fail
    });
    await expect(opened.persist()).rejects.toThrow();
    expect(opened.durabilityError).toBeDefined();
    await expect(opened.persist()).rejects.toThrow();
    await opened.close();
    expect(await readdir(dir)).not.toContain("session.json.lock");
  });

  it("runs ephemerally when no state file is given", async () => {
    const opened = await openPersistentSession({});
    expect(opened.restored).toBe(false);
    await opened.persist();
    await opened.close();
    expect(await readdir(dir)).toEqual([]);
  });
});
