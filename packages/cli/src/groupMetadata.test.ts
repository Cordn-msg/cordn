import { describe, expect, test } from "vitest";

import {
  decodeCordnGroupMetadata,
  encodeCordnGroupMetadata,
} from "./groupMetadata.ts";
import { encodeCordnCoordinatorRouting } from "./coordinatorRouting.ts";

describe("cordn group metadata codec", () => {
  test("roundtrips v1 metadata", () => {
    const metadata = {
      name: "demo",
      description: "shared group",
      adminPubkeys: ["11".repeat(32), "22".repeat(32)],
      icon: "🧵",
      imageUrl: "https://example.com/group.png",
    };

    const encoded = encodeCordnGroupMetadata(metadata);
    const decoded = decodeCordnGroupMetadata(encoded);

    expect(decoded).toEqual(metadata);
  });

  test("treats empty optional fields as absent", () => {
    const encoded = encodeCordnGroupMetadata({ name: "egalitarian" });

    expect(decodeCordnGroupMetadata(encoded)).toEqual({
      name: "egalitarian",
      description: undefined,
      adminPubkeys: undefined,
      icon: undefined,
      imageUrl: undefined,
      coordinatorRouting: undefined,
    });
  });

  test("roundtrips metadata with coordinator routing", () => {
    const routing = {
      active: { pubkey: "11".repeat(32), relayUrls: ["wss://a.example"] },
      fallbacks: [{ pubkey: "22".repeat(32), relayUrls: [] }],
      boundaryTips: ["ab".repeat(32)],
    };
    const encoded = encodeCordnGroupMetadata({
      name: "demo",
      coordinatorRouting: routing,
    });

    expect(decodeCordnGroupMetadata(encoded)).toEqual({
      name: "demo",
      coordinatorRouting: routing,
    });
  });

  test("ignores unknown trailing fields from future versions", () => {
    const encoded = encodeCordnGroupMetadata({ name: "egalitarian" });
    const withFutureField = new Uint8Array([
      ...encoded,
      0,
      3,
      9,
      9,
      9, // a field a future version appended after routing
    ]);

    expect(decodeCordnGroupMetadata(withFutureField)).toEqual({
      name: "egalitarian",
    });
  });

  test("rejects a malformed coordinator routing field", () => {
    const routing = {
      active: { pubkey: "11".repeat(32), relayUrls: [] },
      fallbacks: [{ pubkey: "22".repeat(32), relayUrls: [] }],
      boundaryTips: [],
    };
    const encoded = encodeCordnGroupMetadata({
      name: "demo",
      coordinatorRouting: routing,
    });
    const blob = encodeCordnCoordinatorRouting(routing);
    // Corrupt the routing blob's version field (reserved version 0).
    encoded[encoded.length - blob.length] = 0;
    encoded[encoded.length - blob.length + 1] = 0;

    expect(() => decodeCordnGroupMetadata(encoded)).toThrow(/version/);
  });
});
