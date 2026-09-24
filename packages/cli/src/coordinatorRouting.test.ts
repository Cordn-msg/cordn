import { describe, expect, test } from "vitest";

import {
  decodeCordnCoordinatorRouting,
  encodeCordnCoordinatorRouting,
  type CordnCoordinatorRouting,
} from "./coordinatorRouting.ts";

const A = { pubkey: "11".repeat(32), relayUrls: ["wss://a.example"] };
const B = { pubkey: "22".repeat(32), relayUrls: [] };
const TIP = "ab".repeat(32);

/** Manual byte builder for decode-side (trust boundary) cases. */
function bytes(...parts: (number | number[] | Uint8Array)[]): Uint8Array {
  const flat: number[] = [];
  for (const part of parts) {
    flat.push(...(typeof part === "number" ? [part] : Array.from(part)));
  }
  return Uint8Array.from(flat);
}

/** locator = 32-byte pubkey + uint16-prefixed relay blob (empty here). */
function locator(fill: number): Uint8Array {
  return bytes(Array(32).fill(fill), [0, 0]);
}

describe("cordn coordinator routing codec", () => {
  test("roundtrips v1 routing", () => {
    const routing: CordnCoordinatorRouting = {
      active: A,
      fallbacks: [B, { pubkey: "33".repeat(32), relayUrls: ["wss://c"] }],
      handoffs: [
        { from: A, boundaryTips: [TIP] },
        { from: B, boundaryTips: [] },
      ],
    };

    expect(
      decodeCordnCoordinatorRouting(encodeCordnCoordinatorRouting(routing)),
    ).toEqual(routing);
  });

  test("roundtrips minimal routing", () => {
    const routing: CordnCoordinatorRouting = {
      active: A,
      fallbacks: [B],
      handoffs: [],
    };

    expect(
      decodeCordnCoordinatorRouting(encodeCordnCoordinatorRouting(routing)),
    ).toEqual(routing);
  });

  test("normalizes pubkeys and envelope ids", () => {
    const encoded = encodeCordnCoordinatorRouting({
      active: { pubkey: "AB".repeat(32), relayUrls: [] },
      fallbacks: [B],
      handoffs: [{ from: B, boundaryTips: ["CD".repeat(32)] }],
    });

    expect(decodeCordnCoordinatorRouting(encoded)).toEqual({
      active: { pubkey: "ab".repeat(32), relayUrls: [] },
      fallbacks: [B],
      handoffs: [{ from: B, boundaryTips: ["cd".repeat(32)] }],
    });
  });

  test("requires at least one fallback", () => {
    expect(() =>
      encodeCordnCoordinatorRouting({ active: A, fallbacks: [], handoffs: [] }),
    ).toThrow(/fallback/);

    // version 1 + locator A + empty fallbacks + empty handoffs
    expect(() =>
      decodeCordnCoordinatorRouting(
        bytes([0, 1], locator(0x11), [0, 0], [0, 0]),
      ),
    ).toThrow(/fallback/);
  });

  test("rejects reserved version 0", () => {
    const encoded = encodeCordnCoordinatorRouting({
      active: A,
      fallbacks: [B],
      handoffs: [],
    });
    encoded[0] = 0;
    encoded[1] = 0;

    expect(() => decodeCordnCoordinatorRouting(encoded)).toThrow(/version/);
  });

  test("rejects trailing bytes and truncation on v1", () => {
    const encoded = encodeCordnCoordinatorRouting({
      active: A,
      fallbacks: [B],
      handoffs: [],
    });

    expect(() => decodeCordnCoordinatorRouting(bytes(encoded, [9, 9]))).toThrow(
      /trailing/,
    );
    expect(() =>
      decodeCordnCoordinatorRouting(encoded.slice(0, encoded.length - 1)),
    ).toThrow(/end of cordn coordinator routing/);
  });

  test("tolerates trailing fields of future versions (append-only)", () => {
    const routing: CordnCoordinatorRouting = {
      active: A,
      fallbacks: [B],
      handoffs: [{ from: B, boundaryTips: [TIP] }],
    };
    const encoded = encodeCordnCoordinatorRouting(routing);
    encoded[1] = 2; // pretend version 2 appended fields we do not know

    expect(decodeCordnCoordinatorRouting(bytes(encoded, [1, 2, 3]))).toEqual(
      routing,
    );
  });

  test("rejects invalid pubkeys and envelope ids at the trust boundary", () => {
    expect(() =>
      encodeCordnCoordinatorRouting({
        active: { pubkey: "zz", relayUrls: [] },
        fallbacks: [B],
        handoffs: [],
      }),
    ).toThrow(/pubkey/i);
    expect(() =>
      encodeCordnCoordinatorRouting({
        active: A,
        fallbacks: [B],
        handoffs: [{ from: B, boundaryTips: ["not-an-id"] }],
      }),
    ).toThrow(/envelope id/);

    // version 1 + locator A + fallbacks[B] + handoffs[locator B + tip "hi"]
    // (tips blob content is length-prefixed ids)
    expect(() =>
      decodeCordnCoordinatorRouting(
        bytes(
          [0, 1],
          locator(0x11),
          [0, 34],
          locator(0x22),
          [0, 40],
          locator(0x22),
          [0, 4],
          [0, 2, 0x68, 0x69],
        ),
      ),
    ).toThrow(/envelope id/);
  });
});
