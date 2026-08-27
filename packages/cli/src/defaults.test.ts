import { describe, expect, test } from "vitest";

import { DEFAULT_COORDINATOR_PUBKEY, DEFAULT_RELAY_URLS } from "./defaults.ts";

describe("CLI hosted defaults", () => {
  test("pins the public coordinator and relay set", () => {
    expect(DEFAULT_COORDINATOR_PUBKEY).toBe(
      "92753cbe63e943d0c4a0c61d745437892af6e98f179ce04a7a863aad4e00b1a5",
    );
    expect(DEFAULT_COORDINATOR_PUBKEY).toMatch(/^[0-9a-f]{64}$/);
    expect(DEFAULT_RELAY_URLS).toEqual([
      "wss://relay.contextvm.org",
      "wss://relay2.contextvm.org",
      "wss://relay.primal.net",
    ]);
  });
});
