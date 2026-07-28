import { describe, expect, test } from "vitest";

import { CORDN_GROUP_METADATA_EXTENSION_TYPE } from "@cordn/core";
import { CordnGroupEngine } from "@cordn/sdk/engine";
import type { CordnTransport } from "@cordn/sdk";

describe("@cordn/sdk package resolution", () => {
  test("core, engine subpath, and main transport type all resolve", () => {
    expect(CORDN_GROUP_METADATA_EXTENSION_TYPE).toBe(0xc04d);
    expect(typeof CordnGroupEngine).toBe("function");

    // type-only import of the transport seam compiles (resolution check)
    const transport: CordnTransport | undefined = undefined;
    expect(transport).toBeUndefined();
  });
});
