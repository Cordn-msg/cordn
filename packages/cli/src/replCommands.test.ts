import { PassThrough } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import {
  executeReplCommand,
  knownCommands,
  parseCreateGroupArgs,
  parseUpdateGroupMetadataArgs,
} from "./replCommands.ts";
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
      coordinatorKey: undefined,
      watch: false,
    });
  });

  test("parses the coordinator option", () => {
    expect(
      parseCreateGroupArgs(["demo", "--coordinator", "b".repeat(64)]),
    ).toEqual({
      alias: "demo",
      keyPackageAlias: undefined,
      metadata: undefined,
      coordinatorKey: "b".repeat(64),
      watch: false,
    });
  });

  test("parses the --watch flag", () => {
    expect(parseCreateGroupArgs(["demo", "--watch"])).toEqual({
      alias: "demo",
      keyPackageAlias: undefined,
      metadata: undefined,
      coordinatorKey: undefined,
      watch: true,
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

describe("parseUpdateGroupMetadataArgs", () => {
  test("parses group alias and replacement metadata", () => {
    expect(
      parseUpdateGroupMetadataArgs([
        "demo",
        "--name",
        "Renamed",
        "--description",
        "new description",
        "--icon",
        "🧵",
      ]),
    ).toEqual({
      alias: "demo",
      metadata: {
        name: "Renamed",
        description: "new description",
        icon: "🧵",
      },
    });
  });

  test("requires a name for v1 metadata", () => {
    expect(() => parseUpdateGroupMetadataArgs(["demo"])).toThrow(CliUsageError);
    expect(() =>
      parseUpdateGroupMetadataArgs(["demo", "--description", "hello"]),
    ).toThrow(CliUsageError);
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
      coordinatorKey: undefined,
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
      coordinatorKey: undefined,
    });
  });

  test("passes coordinator to gen-kp publishing", async () => {
    const output = new PassThrough();
    const generateKeyPackage = vi.fn().mockResolvedValue({
      alias: "alice-main",
      keyPackageRef: "alice-ref",
      publishedAt: 123,
    });
    const session = {
      generateKeyPackage,
    } as never;

    await executeReplCommand(
      "gen-kp",
      ["alice-main", "--coordinator", "coordinator-a"],
      {
        session,
        output,
      },
    );

    expect(generateKeyPackage).toHaveBeenCalledWith("alice-main", {
      localOnly: false,
      lastResort: false,
      coordinatorKey: "coordinator-a",
    });
  });

  test("does not treat the --coordinator value as the alias for gen-kp", async () => {
    const output = new PassThrough();
    const generateKeyPackage = vi.fn().mockResolvedValue({
      alias: "kp-1",
      keyPackageRef: "alice-ref",
      publishedAt: 123,
    });
    const session = {
      generateKeyPackage,
    } as never;

    await executeReplCommand("gen-kp", ["--coordinator", "coordinator-a"], {
      session,
      output,
    });

    expect(generateKeyPackage).toHaveBeenCalledWith(undefined, {
      localOnly: false,
      lastResort: false,
      coordinatorKey: "coordinator-a",
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
    expect(knownCommands.has("kps")).toBe(true);
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
      coordinatorKey: undefined,
    });
  });

  test("passes coordinator to available-kps", async () => {
    const output = new PassThrough();
    const listAvailableKeyPackageSummaries = vi.fn().mockResolvedValue([]);
    const session = {
      listAvailableKeyPackageSummaries,
    } as never;

    await executeReplCommand(
      "available-kps",
      ["--coordinator", "a".repeat(64)],
      {
        session,
        output,
      },
    );

    expect(listAvailableKeyPackageSummaries).toHaveBeenCalledWith(
      "a".repeat(64),
    );
  });

  test("passes coordinator to accept-welcome", async () => {
    const output = new PassThrough();
    const acceptWelcome = vi.fn().mockResolvedValue({
      alias: "demo",
      metadata: undefined,
    });
    const session = {
      acceptWelcome,
    } as never;

    await executeReplCommand(
      "accept-welcome",
      ["kp-ref", "demo", "--coordinator", "c".repeat(64)],
      {
        session,
        output,
      },
    );

    expect(acceptWelcome).toHaveBeenCalledWith(
      "kp-ref",
      "demo",
      "c".repeat(64),
    );
  });

  test("starts watching after create-group --watch", async () => {
    const output = new PassThrough();
    const createGroup = vi.fn().mockResolvedValue({
      alias: "demo",
      metadata: undefined,
    });
    const watchGroup = vi.fn().mockResolvedValue(undefined);
    const session = {
      createGroup,
      watchGroup,
    } as never;

    await executeReplCommand("create-group", ["demo", "--watch"], {
      session,
      output,
    });

    expect(watchGroup).toHaveBeenCalledWith("demo");
  });

  test("supports watch-all", async () => {
    const output = new PassThrough();
    const watchAllGroups = vi.fn().mockResolvedValue(undefined);
    const session = {
      watchAllGroups,
    } as never;

    await executeReplCommand("watch-all", [], {
      session,
      output,
    });

    expect(watchAllGroups).toHaveBeenCalledOnce();
  });

  test("supports unwatch", async () => {
    const output = new PassThrough();
    const unwatchGroup = vi.fn().mockResolvedValue(undefined);
    const session = {
      unwatchGroup,
    } as never;

    await executeReplCommand("unwatch", ["demo"], {
      session,
      output,
    });

    expect(unwatchGroup).toHaveBeenCalledWith("demo");
  });

  test("syncs before and after add-member", async () => {
    const output = new PassThrough();
    const syncGroup = vi.fn().mockResolvedValue([]);
    const addMember = vi.fn().mockResolvedValue({
      keyPackageReference: "a".repeat(64),
    });
    const session = {
      syncGroup,
      addMember,
    } as never;

    await executeReplCommand("add-member", ["demo", "b".repeat(64)], {
      session,
      output,
    });

    expect(syncGroup).toHaveBeenNthCalledWith(1, "demo");
    expect(addMember).toHaveBeenCalledWith("demo", "b".repeat(64));
    expect(syncGroup).toHaveBeenNthCalledWith(2, "demo");
  });

  test("syncs before and after remove-member", async () => {
    const output = new PassThrough();
    const syncGroup = vi.fn().mockResolvedValue([]);
    const removeMember = vi.fn().mockResolvedValue({
      targetStablePubkey: "b".repeat(64),
    });
    const session = {
      syncGroup,
      removeMember,
    } as never;

    await executeReplCommand("remove-member", ["demo", "b".repeat(64)], {
      session,
      output,
    });

    expect(syncGroup).toHaveBeenNthCalledWith(1, "demo");
    expect(removeMember).toHaveBeenCalledWith("demo", "b".repeat(64));
    expect(syncGroup).toHaveBeenNthCalledWith(2, "demo");
  });

  test("syncs before and after update-group-metadata", async () => {
    const output = new PassThrough();
    const syncGroup = vi.fn().mockResolvedValue([]);
    const updateGroupMetadata = vi.fn().mockResolvedValue({
      metadata: { name: "Renamed" },
    });
    const session = {
      syncGroup,
      updateGroupMetadata,
    } as never;

    await executeReplCommand(
      "update-group-metadata",
      ["demo", "--name", "Renamed"],
      {
        session,
        output,
      },
    );

    expect(syncGroup).toHaveBeenNthCalledWith(1, "demo");
    expect(updateGroupMetadata).toHaveBeenCalledWith("demo", {
      name: "Renamed",
    });
    expect(syncGroup).toHaveBeenNthCalledWith(2, "demo");
  });

  test("accept-welcome --watch does not treat the flag as the alias", async () => {
    const output = new PassThrough();
    const acceptWelcome = vi.fn().mockResolvedValue({
      alias: "demo",
      metadata: undefined,
    });
    const watchGroup = vi.fn().mockResolvedValue(undefined);
    const session = {
      acceptWelcome,
      watchGroup,
    } as never;

    await executeReplCommand("accept-welcome", ["kp-ref", "--watch"], {
      session,
      output,
    });

    expect(acceptWelcome).toHaveBeenCalledWith("kp-ref", undefined, undefined);
    expect(watchGroup).toHaveBeenCalledWith("demo");
  });
});
