import { describe, expect, test } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { createActor, createMemberArtifacts } from "@cordn/test-utils";
import { encodeBase64, encodeKeyPackage } from "@cordn/core";

import { decodeKeyPackageFromPublicationEvent } from "./contextVmTransport.ts";

function event(content: string, pubkey: string): NostrEvent {
  return {
    id: "0".repeat(64),
    pubkey,
    created_at: 1,
    kind: 1,
    tags: [],
    content,
    sig: "0".repeat(128),
  };
}

describe("decodeKeyPackageFromPublicationEvent", () => {
  test("extracts kp_64 from the MCP JSON-RPC envelope the server stores", async () => {
    const { actor, keyPackage } = await member();
    const kp64 = encodeBase64(encodeKeyPackage(keyPackage));
    const e = event(
      JSON.stringify({
        method: "tools/call",
        params: { name: "kp_publish", arguments: { kp_ref: "r", kp_64: kp64 } },
        jsonrpc: "2.0",
        id: 1,
      }),
      actor.stablePubkey,
    );
    expect(
      encodeBase64(encodeKeyPackage(decodeKeyPackageFromPublicationEvent(e))),
    ).toBe(kp64);
  });

  test("throws when kp_64 is absent", async () => {
    const { actor } = await member();
    const e = event(
      JSON.stringify({ params: { arguments: {} } }),
      actor.stablePubkey,
    );
    expect(() => decodeKeyPackageFromPublicationEvent(e)).toThrow(
      /Missing kp_64/,
    );
  });
});

async function member() {
  const artifacts = await createMemberArtifacts(createActor("alice"));
  return {
    actor: artifacts.actor,
    keyPackage: artifacts.keyPackage,
  };
}
