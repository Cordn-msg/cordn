import { describe, expect, test } from "vitest";

import { CliSession } from "./session.ts";

describe("CLI session snapshots", () => {
  const serverPubkey = "11".repeat(32);

  test("restores identity and private KeyPackage state", async () => {
    const original = new CliSession({ serverPubkey });
    await original.generateKeyPackage("writer", {
      localOnly: true,
      lastResort: true,
    });
    const snapshot = original.exportSnapshot();
    const restored = new CliSession({
      privateKey: original.privateKey,
      serverPubkey,
    });

    await restored.restoreSnapshot(snapshot);

    expect(restored.stablePubkey).toBe(original.stablePubkey);
    expect(restored.listKeyPackages()).toMatchObject([
      {
        alias: "writer",
        keyPackageRef: original.listKeyPackages()[0]?.keyPackageRef,
        isLastResort: true,
        consumed: false,
      },
    ]);
    expect(restored.exportSnapshot()).toEqual(snapshot);
    await Promise.all([original.disconnect(), restored.disconnect()]);
  });

  test("rejects a snapshot belonging to another identity", async () => {
    const original = new CliSession({ serverPubkey });
    const other = new CliSession({ serverPubkey });

    await expect(
      other.restoreSnapshot(original.exportSnapshot()),
    ).rejects.toThrow("snapshot identity does not match CLI identity");
    await Promise.all([original.disconnect(), other.disconnect()]);
  });
});
