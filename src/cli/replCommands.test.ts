import { describe, expect, test } from "vitest";

import { parseCreateGroupArgs } from "./replCommands.ts";
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
