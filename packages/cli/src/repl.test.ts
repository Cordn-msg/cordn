import { describe, expect, test } from "vitest";

import { isReplAbort } from "./repl.ts";

describe("CLI REPL", () => {
  test("treats readline Ctrl+C as a graceful exit", () => {
    expect(
      isReplAbort(
        Object.assign(new Error("Aborted with Ctrl+C"), {
          code: "ABORT_ERR",
        }),
      ),
    ).toBe(true);
    expect(isReplAbort(new Error("network failed"))).toBe(false);
  });
});
