import { describe, expect, test } from "vitest";

import {
  causalPrevTags,
  causalTips,
  createUnsignedCordnMessageEvent,
  decodeCordnMessageEvent,
  encodeCordnMessageEvent,
  finalizeCordnMessageEvent,
  prevLinksOf,
} from "./messageEnvelope.ts";

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const PUBKEY = "cc".repeat(32);

function msg(
  id: string,
  parents: string[] = [],
): {
  id: string;
  tags: string[][];
} {
  return { id, tags: parents.map((parent) => ["prev", parent]) };
}

function envelopeWithTags(tags: string[][]) {
  return finalizeCordnMessageEvent(
    createUnsignedCordnMessageEvent({ pubkey: PUBKEY, content: "x", tags }),
  );
}

describe("causal prev links (coordinator-handoff.md §6)", () => {
  test("prevLinksOf reads only prev tags", () => {
    expect(
      prevLinksOf([
        ["prev", A],
        ["imeta", "url"],
        ["e", B],
        ["prev", B],
      ]),
    ).toEqual([A, B]);
  });

  test("a chain has one tip; a merge joins concurrent tips (§6.3)", () => {
    expect(causalTips([msg("a"), msg("b", ["a"])])).toEqual(["b"]);
    expect(
      causalTips([msg("a"), msg("b", ["a"]), msg("c", ["a"])]).sort(),
    ).toEqual(["b", "c"]);
    expect(
      causalTips([
        msg("a"),
        msg("b", ["a"]),
        msg("c", ["a"]),
        msg("m", ["b", "c"]),
      ]),
    ).toEqual(["m"]);
  });

  test("a re-sent duplicate cannot resurrect an old tip (§6.2)", () => {
    // b links a; re-sending a afterwards must not make a a tip again.
    expect(causalTips([msg("a"), msg("b", ["a"]), msg("a")])).toEqual(["b"]);
  });

  test("causalPrevTags builds one tag per tip", () => {
    expect(
      causalPrevTags([msg("a"), msg("b", ["a"]), msg("c", ["a"])]),
    ).toEqual(
      [
        ["prev", "b"],
        ["prev", "c"],
      ].sort(),
    );
  });

  test("decode rejects malformed prev values and shapes (§14)", () => {
    const badValue = envelopeWithTags([["prev", "not-an-id"]]);
    expect(() =>
      decodeCordnMessageEvent(encodeCordnMessageEvent(badValue)),
    ).toThrow(/prev/);

    // one-parent-per-tag shape: no extra elements
    const badShape = envelopeWithTags([["prev", A, "extra"]]);
    expect(() =>
      decodeCordnMessageEvent(encodeCordnMessageEvent(badShape)),
    ).toThrow(/prev/);
  });

  test("roundtrips an envelope with valid prev links", () => {
    const event = envelopeWithTags([
      ["prev", A],
      ["imeta", "u"],
    ]);
    const decoded = decodeCordnMessageEvent(encodeCordnMessageEvent(event));

    expect(decoded.id).toBe(event.id);
    expect(prevLinksOf(decoded.tags)).toEqual([A]);
  });
});
