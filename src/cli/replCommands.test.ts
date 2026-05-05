import { PassThrough } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import { executeReplCommand, parseCreateGroupArgs } from "./replCommands.ts";
import { CliUsageError } from "./sessionErrors.ts";

describe("parseCreateGroupArgs", () => {
  test("parses alias, optional key package alias, and metadata flags", () => {
    expect(
      parseCreateGroupArgs([
        "demo",
        "alice-main",
        "--name",
        "Demo Group",
        "--description",
        "hello",
        "--admin",
        "a".repeat(64),
      ]),
    ).toEqual({
      alias: "demo",
      keyPackageAlias: "alice-main",
      metadata: {
        name: "Demo Group",
        description: "hello",
        adminPubkeys: ["a".repeat(64)],
      },
    });
  });

  test("throws typed usage errors for invalid arguments", () => {
    expect(() => parseCreateGroupArgs([])).toThrow(CliUsageError);
    expect(() =>
      parseCreateGroupArgs(["demo", "--description", "hello"]),
    ).toThrow(CliUsageError);
    expect(() => parseCreateGroupArgs(["demo", "--unknown", "value"])).toThrow(
      CliUsageError,
    );
  });
});

describe("executeReplCommand", () => {
  test("supports last-resort and local-only gen-kp flags", async () => {
    const output = new PassThrough();
    const generateKeyPackage = vi.fn().mockResolvedValue({
      alias: "alice-main",
      keyPackageRef: "alice-ref",
    });
    const session = {
      generateKeyPackage: vi.fn().mockResolvedValue({
        alias: "alice-main",
        keyPackageRef: "alice-ref",
      }),
    } as never;
    Object.assign(session, { generateKeyPackage });

    await executeReplCommand(
      "gen-kp",
      ["alice-main", "--last-resort", "--local-only"],
      {
        session,
        output,
      },
    );

    expect(generateKeyPackage).toHaveBeenCalledWith("alice-main", {
      localOnly: true,
      lastResort: true,
    });
  });

  test("does not treat gen-kp flags as the alias when no alias is provided", async () => {
    const output = new PassThrough();
    const generateKeyPackage = vi.fn().mockResolvedValue({
      alias: "kp-1",
      keyPackageRef: "alice-ref",
    });
    const session = {
      generateKeyPackage,
    } as never;

    await executeReplCommand("gen-kp", ["--last-resort"], {
      session,
      output,
    });

    expect(generateKeyPackage).toHaveBeenCalledWith(undefined, {
      localOnly: false,
      lastResort: true,
    });
  });

  test("supports kps as an alias for key-packages", async () => {
    const output = new PassThrough();
    const listKeyPackageSummaries = vi.fn().mockReturnValue([]);
    const session = {
      listKeyPackageSummaries,
    } as never;

    await executeReplCommand("kps", [], {
      session,
      output,
    });

    expect(listKeyPackageSummaries).toHaveBeenCalledOnce();
  });

  test("supports delete-kp", async () => {
    const output = new PassThrough();
    const deleteKeyPackage = vi.fn().mockResolvedValue({
      keyPackageRef: "alice-ref",
      removedLocal: true,
    });
    const session = {
      deleteKeyPackage: vi.fn().mockResolvedValue({
        keyPackageRef: "alice-ref",
        removedLocal: true,
      }),
    } as never;
    Object.assign(session, { deleteKeyPackage });

    await executeReplCommand("delete-kp", ["alice-main"], {
      session,
      output,
    });

    expect(deleteKeyPackage).toHaveBeenCalledWith("alice-main", {
      localOnly: false,
    });
  });
});
