import { describe, expect, test } from "vitest";

import {
  decodeCordnGroupMetadata,
  encodeCordnCoordinatorRouting,
  encodeCordnGroupMetadata,
  metadataWithVoidedRouting,
  normalizePubkey,
  safeNormalizePubkey,
  type CordnGroupMetadata,
} from "./groupMetadata.ts";

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

describe("normalization (single definition across clients)", () => {
  test("normalizePubkey trims before validating and lowercases", () => {
    expect(normalizePubkey(`  ${"AB".repeat(32)} `)).toBe("ab".repeat(32));
    expect(() => normalizePubkey("1234")).toThrow(/Invalid pubkey/);
  });

  test("safeNormalizePubkey returns empty instead of throwing", () => {
    expect(safeNormalizePubkey("1234")).toBe("");
  });

  test("admin duplicates are rejected after normalization", () => {
    expect(() =>
      encodeCordnGroupMetadata({
        name: "demo",
        adminPubkeys: ["AB".repeat(32), "ab".repeat(32)],
      }),
    ).toThrow(/duplicates/);
  });

  test("a blank admin entry is rejected, never silently egalitarian", () => {
    expect(() =>
      encodeCordnGroupMetadata({ name: "demo", adminPubkeys: [""] }),
    ).toThrow(/Invalid pubkey/);
  });

  test("decode dedupes hostile repeated admin entries (ingestion never aborts)", () => {
    const u16 = (value: number): number[] => [
      (value >> 8) & 0xff,
      value & 0xff,
    ];
    const field = (data: number[]): number[] => [...u16(data.length), ...data];
    const admin = Array(32).fill(0x11);
    const blob = Uint8Array.from([
      ...u16(1),
      ...field([...new TextEncoder().encode("demo")]),
      ...field([]),
      ...field([...admin, ...admin]), // the same admin twice
      ...field([]),
      ...field([]),
      ...field([]), // empty routing trailing field
    ]);

    expect(decodeCordnGroupMetadata(blob).adminPubkeys).toEqual([
      "11".repeat(32),
    ]);
  });
});

describe("routing void rule (coordinator-handoff §4.4)", () => {
  const good = { pubkey: "11".repeat(32), relayUrls: [] };
  const fallback = { pubkey: "22".repeat(32), relayUrls: [] };
  const rogue = { pubkey: "44".repeat(32), relayUrls: [] };
  const previous: CordnGroupMetadata = {
    name: "demo",
    coordinatorRouting: {
      active: good,
      fallbacks: [fallback],
      boundaryTips: [],
    },
  };

  test("voids a move of active outside the declared fallbacks", () => {
    const routed = metadataWithVoidedRouting(previous, {
      ...previous,
      coordinatorRouting: {
        active: rogue,
        fallbacks: [fallback],
        boundaryTips: [],
      },
    });

    expect(routed.voided).toBe(true);
    expect(routed.metadata?.coordinatorRouting?.active.pubkey).toBe(
      good.pubkey,
    );
  });

  test("allows a move of active within the declared fallbacks", () => {
    const routed = metadataWithVoidedRouting(previous, {
      ...previous,
      coordinatorRouting: {
        active: fallback,
        fallbacks: [good],
        boundaryTips: [],
      },
    });

    expect(routed.voided).toBe(false);
  });

  test("allows roster edits that keep active", () => {
    const routed = metadataWithVoidedRouting(previous, {
      ...previous,
      coordinatorRouting: {
        active: good,
        fallbacks: [fallback, rogue],
        boundaryTips: [],
      },
    });

    expect(routed.voided).toBe(false);
  });
});
