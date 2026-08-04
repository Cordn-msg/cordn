import { describe, expect, test } from "vitest";
import { bech32, bech32m } from "@scure/base";

import { decodeGroupRef, encodeGroupRef, isGroupRef } from "./groupRef.ts";

// --- independent helpers for building adversarial bech32 vectors -------------
// These assemble TLV + bech32 directly via @scure/base, NOT via the codec under
// test, so malformed inputs and the golden cross-check are not self-fulfilling.

const utf8 = new TextEncoder();
const GID = "550e8400-e29b-41d4-a716-446655440000";
const PUBKEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const RELAYS = ["wss://relay.example.com", "wss://backup.example.com"];

function tlv(type: number, value: Uint8Array): Uint8Array {
  if (value.length > 255) {
    throw new Error(
      `test helper: TLV type ${type} value (${value.length} bytes) exceeds the 1-byte length field`,
    );
  }
  const entry = new Uint8Array(value.length + 2);
  entry[0] = type;
  entry[1] = value.length;
  entry.set(value, 2);
  return entry;
}

function encodeRaw(
  parts: Uint8Array[],
  opts: { prefix?: string; useBech32m?: boolean } = {},
): string {
  const prefix = opts.prefix ?? "cordn";
  const words = bech32.toWords(Buffer.concat(parts));
  return (opts.useBech32m ? bech32m : bech32).encode(prefix, words, 5000);
}

const gidBytes = (): Uint8Array => utf8.encode(GID);
const pubkeyBytes = (): Uint8Array =>
  Uint8Array.from(Buffer.from(PUBKEY, "hex"));

// Golden vectors, cross-validated against the independent assembly above. Pin
// them as literals so a silent change in the encoder breaks the test.
const GOLDEN_GID_ONLY =
  "cordn1qqjr2dfsv5urgvps94jnywtz956rzep594snwvfk956rgd3kx56ngdpsxqcrqy4yh7d";
const GOLDEN_GID_PUBKEY =
  "cordn1qysqzg69v7y6hn00qy352euf40x77qfrg4ncn27dauqjx3t83x4ummcqys6n2vr98q6rqvpdv5erjc3dxsckgdpdvymnzd3dxs6rvd34x56rgvpsxqcqfqnsvd";
const GOLDEN_FULL =
  "cordn1qgthwumn8ghj7un9d3shjtn90psk6urvv5hxxmmdqgv8wumn8ghj7cnpvd4h2upwv4uxzmtsd3jjucm0d5qjqqfrg4ncn27dauqjx3t83x4ummcpydzk0zdtehhszg69v7y6hn00qqjr2dfsv5urgvps94jnywtz956rzep594snwvfk956rgd3kx56ngdpsxqcrqv7vzv4";

describe("groupRef golden vectors", () => {
  test("encoder matches independent TLV+bech32 assembly", () => {
    expect(encodeGroupRef({ gid: GID })).toBe(GOLDEN_GID_ONLY);
    expect(encodeGroupRef({ gid: GID, coordinatorPubkey: PUBKEY })).toBe(
      GOLDEN_GID_PUBKEY,
    );
    expect(
      encodeGroupRef({ gid: GID, coordinatorPubkey: PUBKEY, relays: RELAYS }),
    ).toBe(GOLDEN_FULL);
  });

  test("decodes to the expected structured form", () => {
    expect(decodeGroupRef(GOLDEN_GID_ONLY)).toEqual({ gid: GID });
    expect(decodeGroupRef(GOLDEN_GID_PUBKEY)).toEqual({
      gid: GID,
      coordinatorPubkey: PUBKEY,
    });
    expect(decodeGroupRef(GOLDEN_FULL)).toEqual({
      gid: GID,
      coordinatorPubkey: PUBKEY,
      relays: RELAYS,
    });
  });
});

describe("groupRef round trip", () => {
  test("optional fields are omitted from the decoded object when absent", () => {
    const code = encodeGroupRef({ gid: "solo-group-id" });
    expect(decodeGroupRef(code)).toEqual({ gid: "solo-group-id" });
    expect("coordinatorPubkey" in decodeGroupRef(code)).toBe(false);
  });

  test("preserves a multi-relay ordering", () => {
    const relays = ["wss://a.example", "wss://b.example", "wss://c.example"];
    const code = encodeGroupRef({
      gid: "g",
      coordinatorPubkey: PUBKEY,
      relays,
    });
    expect(decodeGroupRef(code).relays).toEqual(relays);
  });

  test("gid is round-tripped verbatim with no trimming", () => {
    const gid = "  keep-my-spaces-==-and-case-XYZ  ";
    const code = encodeGroupRef({ gid });
    expect(decodeGroupRef(code).gid).toBe(gid);
  });

  test("accepts the 255-byte gid boundary", () => {
    const gid = "a".repeat(255);
    const code = encodeGroupRef({ gid });
    expect(decodeGroupRef(code).gid).toBe(gid);
  });
});

describe("groupRef decode validation", () => {
  const expectDecodeError = (code: string, needle: string): void => {
    expect(() => decodeGroupRef(code)).toThrow(needle);
  };

  test("rejects an invalid checksum", () => {
    const last = GOLDEN_GID_ONLY.at(-1)!;
    const flipped = last === "q" ? "p" : "q";
    expectDecodeError(
      GOLDEN_GID_ONLY.slice(0, -1) + flipped,
      "malformed bech32",
    );
  });

  test("rejects the bech32m variant", () => {
    expectDecodeError(
      encodeRaw([tlv(0, gidBytes())], { useBech32m: true }),
      "malformed bech32",
    );
  });

  test("rejects a foreign prefix", () => {
    expectDecodeError(
      encodeRaw([tlv(0, gidBytes())], { prefix: "nprofile" }),
      'expected prefix "cordn"',
    );
  });

  test("rejects a missing gid", () => {
    expectDecodeError(encodeRaw([]), "missing gid");
  });

  test("rejects multiple gids", () => {
    expectDecodeError(
      encodeRaw([tlv(0, gidBytes()), tlv(0, gidBytes())]),
      "multiple gids",
    );
  });

  test("rejects an empty gid", () => {
    expectDecodeError(
      encodeRaw([tlv(0, new Uint8Array())]),
      "gid must be non-empty",
    );
  });

  test("rejects a gid that is not valid UTF-8", () => {
    expectDecodeError(
      encodeRaw([tlv(0, Uint8Array.from([0xff, 0xfe]))]),
      "not valid UTF-8",
    );
  });

  test("rejects multiple coordinator pubkeys", () => {
    expectDecodeError(
      encodeRaw([
        tlv(1, pubkeyBytes()),
        tlv(1, pubkeyBytes()),
        tlv(0, gidBytes()),
      ]),
      "multiple coordinator pubkeys",
    );
  });

  test("rejects a coordinator pubkey that is not 32 bytes", () => {
    expectDecodeError(
      encodeRaw([tlv(1, new Uint8Array(16)), tlv(0, gidBytes())]),
      "coordinatorPubkey must be 32 bytes",
    );
  });

  test("rejects relays without a coordinator pubkey", () => {
    expectDecodeError(
      encodeRaw([tlv(2, utf8.encode("wss://r.example")), tlv(0, gidBytes())]),
      "relays require a coordinatorPubkey",
    );
  });

  test("rejects a relay that is not valid UTF-8", () => {
    expectDecodeError(
      encodeRaw([
        tlv(2, Uint8Array.from([0xff])),
        tlv(1, pubkeyBytes()),
        tlv(0, gidBytes()),
      ]),
      "not valid UTF-8",
    );
  });

  test("rejects a truncated TLV header", () => {
    // A single trailing byte: type byte present, length byte missing.
    expectDecodeError(
      encodeRaw([tlv(0, gidBytes()), new Uint8Array([99])]),
      "truncated TLV",
    );
  });
});

describe("groupRef encode validation", () => {
  const expectEncodeError = (
    ref: Parameters<typeof encodeGroupRef>[0],
    needle: string,
  ): void => {
    expect(() => encodeGroupRef(ref)).toThrow(needle);
  };

  test("rejects an empty gid", () => {
    expectEncodeError({ gid: "" }, "gid must be non-empty");
  });

  test("rejects a gid exceeding 255 bytes", () => {
    expectEncodeError({ gid: "x".repeat(256) }, "gid exceeds 255 bytes");
  });

  test("rejects a malformed coordinator pubkey", () => {
    expectEncodeError(
      { gid: "g", coordinatorPubkey: "not-hex" },
      "coordinatorPubkey must be 64 lowercase hex chars",
    );
  });

  test("rejects an uppercase coordinator pubkey (canonical is lowercase)", () => {
    expectEncodeError(
      { gid: "g", coordinatorPubkey: PUBKEY.toUpperCase() },
      "coordinatorPubkey must be 64 lowercase hex chars",
    );
  });

  test("rejects relays without a coordinator pubkey", () => {
    expectEncodeError(
      { gid: "g", relays: ["wss://r.example"] },
      "relays require a coordinatorPubkey",
    );
  });
});

describe("groupRef forward compatibility", () => {
  test("ignores unrecognized TLV types", () => {
    const code = encodeRaw([
      tlv(99, utf8.encode("future-field")),
      tlv(1, pubkeyBytes()),
      tlv(2, utf8.encode("wss://r.example")),
      tlv(0, gidBytes()),
    ]);
    expect(decodeGroupRef(code)).toEqual({
      gid: GID,
      coordinatorPubkey: PUBKEY,
      relays: ["wss://r.example"],
    });
  });

  test("accepts TLV elements in any order (ascending)", () => {
    const ascending = encodeRaw([
      tlv(0, gidBytes()),
      tlv(1, pubkeyBytes()),
      tlv(2, utf8.encode("wss://a.example")),
      tlv(2, utf8.encode("wss://b.example")),
    ]);
    expect(decodeGroupRef(ascending)).toEqual({
      gid: GID,
      coordinatorPubkey: PUBKEY,
      relays: ["wss://a.example", "wss://b.example"],
    });
  });
});

describe("isGroupRef", () => {
  test("true for valid-looking cordn references, false otherwise", () => {
    expect(isGroupRef(GOLDEN_GID_ONLY)).toBe(true);
    expect(isGroupRef(GOLDEN_FULL)).toBe(true);
    // Loose detector: does not verify the checksum, only shape.
    expect(isGroupRef(GOLDEN_GID_ONLY.slice(0, -1) + "q")).toBe(true);
  });

  test("false for foreign prefixes, too-short tails, non-cordn strings", () => {
    expect(isGroupRef("nprofile1" + "q".repeat(20))).toBe(false);
    expect(isGroupRef("cordn1abcde")).toBe(false); // tail shorter than a checksum
    expect(isGroupRef("CORDN1" + "q".repeat(20))).toBe(false); // case-sensitive
    expect(isGroupRef("")).toBe(false);
    expect(isGroupRef("not a code")).toBe(false);
  });
});
