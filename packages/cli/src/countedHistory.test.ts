import { describe, expect, test } from "vitest";

import {
  adjudicate,
  canonicalPosition,
  checkRoutingChain,
  comparePositions,
  isVoidPosition,
  segmentLocator,
  tipsOf,
  virtualCursor,
  type Adjudication,
  type HistoryRecord,
  type RoutingState,
  type SegmentCut,
} from "./countedHistory.ts";

/** spec/applications/coordinator-handoff.md conformance and stress tests for
 * the counted-history rules (§4.4, §5, §6.2, §6.3, §7). */

function rec(
  id: string,
  segment: number,
  cursor: number,
  parents: string[] = [],
): HistoryRecord {
  return { id, parents, position: { segment, cursor } };
}

describe("spec §13 worked example", () => {
  const r36 = rec("r36", 0, 36);
  const r37 = rec("r37", 0, 37, ["r36"]);
  const slow = rec("slow", 0, 38, ["r37"]); // written before the cut, not ingested by the committer
  const late = rec("late", 0, 41, ["r37"]); // written after the cut
  const next = rec("next", 1, 1, ["slow"]); // author's first record on the new segment
  const cut: SegmentCut = { boundaryCursor: 39, boundaryTips: ["r37"] };

  const result = adjudicate([r36, r37, slow, late, next], [cut]);

  test("chat message at (0, 12) displays as virtual 12", () => {
    expect(virtualCursor({ segment: 0, cursor: 12 }, [cut])).toBe(12);
  });

  test("seam numbering: (1, 1) displays as virtual 41", () => {
    expect(virtualCursor({ segment: 0, cursor: 39 }, [cut])).toBe(39);
    expect(virtualCursor({ segment: 1, cursor: 1 }, [cut])).toBe(41);
  });

  test("late write to the closed segment is orphaned", () => {
    expect(result.orphaned.has("late")).toBe(true);
    expect(result.counted.has("late")).toBe(false);
  });

  test("pre-cut record pulled in by later linkage is counted at (0, 38), virtual 38", () => {
    expect(result.counted.has("slow")).toBe(true);
    expect(virtualCursor(slow.position, [cut])).toBe(38);
  });

  test("boundary tips and their ancestors are counted; no gaps", () => {
    expect(result.counted.has("r37")).toBe(true);
    expect(result.counted.has("r36")).toBe(true);
    expect([...result.gaps]).toEqual([]);
  });
});

describe("§7.1/§7.2 adjudication rules", () => {
  const cut: SegmentCut = { boundaryCursor: 39, boundaryTips: ["tip"] };

  function legacyResult(): Adjudication {
    return adjudicate(
      [rec("tip", 0, 30), rec("leg", 0, 35), rec("legAbove", 0, 45)],
      [cut],
    );
  }

  test("open-segment records are provisionally counted", () => {
    const result = adjudicate([rec("o", 1, 5, ["tip"])], [cut]);
    expect(result.counted.has("o")).toBe(true);
    expect(result.orphaned.size).toBe(0);
  });

  test("unlinked record at or below boundary_cursor counts (legacy tolerance)", () => {
    expect(legacyResult().counted.has("leg")).toBe(true);
  });

  test("unlinked record above boundary_cursor is orphaned", () => {
    expect(legacyResult().orphaned.has("legAbove")).toBe(true);
  });

  test("pull-in is transitive across segments", () => {
    const x = rec("x", 0, 19); // legacy-tolerated seed
    const a = rec("a", 0, 20, ["x"]); // linked: needs pull-in
    const b = rec("b", 0, 21, ["a"]);
    const c = rec("c", 1, 1, ["b"]);
    const result = adjudicate(
      [x, a, b, c],
      [{ boundaryCursor: 39, boundaryTips: [] }],
    );
    expect(result.counted.has("b")).toBe(true); // direct parent of an open record
    expect(result.counted.has("a")).toBe(true); // transitive
    expect(result.counted.has("x")).toBe(true);
  });

  test("missing parents and unknown boundary tips are gaps (§8)", () => {
    const result = adjudicate(
      [rec("x", 1, 1, ["ghost"])],
      [{ boundaryCursor: 10, boundaryTips: ["phantom"] }],
    );
    expect([...result.gaps].sort()).toEqual(["ghost", "phantom"]);
    expect(result.counted.has("x")).toBe(true);
  });

  test("classification is provisional: counted → orphaned → counted as knowledge grows (§7.1)", () => {
    const s = rec("s", 0, 25);
    // Live receipt while the segment is open: provisionally counted.
    expect(adjudicate([s], []).counted.has("s")).toBe(true);
    // The cut closes without it and nothing links it: orphaned (discard).
    const closing = adjudicate([s], [{ boundaryCursor: 20, boundaryTips: [] }]);
    expect(closing.orphaned.has("s")).toBe(true);
    // Its author's next record pulls it back in: counted again (re-ingest).
    const pulled = adjudicate(
      [s, rec("n", 1, 1, ["s"])],
      [{ boundaryCursor: 20, boundaryTips: [] }],
    );
    expect(pulled.counted.has("s")).toBe(true);
  });
});

describe("§6.2 re-sent identity", () => {
  test("a re-sent id is one record at its canonical (lowest) position, in any arrival order", () => {
    const original = rec("m", 0, 5);
    const copy = rec("m", 1, 2);
    const cut: SegmentCut = { boundaryCursor: 4, boundaryTips: [] };

    const first = adjudicate([original, copy], [cut]);
    const second = adjudicate([copy, original], [cut]);

    expect([...first.counted]).toEqual(["m"]); // the open-segment copy counts
    expect([...first.orphaned]).toEqual([]);
    expect([...second.counted]).toEqual(["m"]);
    expect([...second.orphaned]).toEqual([]);
    expect(canonicalPosition([original.position, copy.position])).toEqual({
      segment: 0,
      cursor: 5,
    });
  });
});

describe("§4.4 routing chain rules", () => {
  test("planned handoff appends exactly one record with from == previous active", () => {
    expect(
      checkRoutingChain([
        { active: "A", handoffFroms: [] },
        { active: "B", handoffFroms: ["A"] },
        { active: "B", handoffFroms: ["A"] }, // roster edit: chain unchanged
      ]),
    ).toEqual([]);
  });

  test("active change without an appended record is a violation", () => {
    expect(
      checkRoutingChain([
        { active: "A", handoffFroms: [] },
        { active: "B", handoffFroms: [] },
      ]),
    ).toHaveLength(1);
  });

  test("appended record whose 'from' differs from previous active is a violation", () => {
    expect(
      checkRoutingChain([
        { active: "A", handoffFroms: [] },
        { active: "B", handoffFroms: ["C"] },
      ]),
    ).toHaveLength(1);
  });

  test("chain growth with unchanged active is a violation", () => {
    expect(
      checkRoutingChain([
        { active: "A", handoffFroms: [] },
        { active: "A", handoffFroms: ["A"] },
      ]),
    ).toHaveLength(1);
  });

  test("re-activating a coordinator that already served the group is a violation (§4.4)", () => {
    expect(
      checkRoutingChain([
        { active: "A", handoffFroms: [] },
        { active: "B", handoffFroms: ["A"] },
        { active: "A", handoffFroms: ["A", "B"] }, // well-formed append, but A served already
      ]),
    ).toHaveLength(1);
  });

  test("concurrent planned handoffs serialize into a chain-violating sequence — detectable here, and the spec voids the stale update (§7.3, §14)", () => {
    // Two members build updates against A; B's commit lands first, C's second.
    const errors = checkRoutingChain([
      { active: "A", handoffFroms: [] },
      { active: "B", handoffFroms: ["A"] },
      { active: "C", handoffFroms: ["A"] }, // stale: 'from' should be "B"
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("§5 positions, numbering, and stale markers", () => {
  const cuts: SegmentCut[] = [
    { boundaryCursor: 10, boundaryTips: [] },
    { boundaryCursor: 5, boundaryTips: [] },
  ];

  test("bases accumulate boundary_cursor + 1 per segment", () => {
    expect(virtualCursor({ segment: 0, cursor: 10 }, cuts)).toBe(10);
    expect(virtualCursor({ segment: 1, cursor: 1 }, cuts)).toBe(12);
    expect(virtualCursor({ segment: 2, cursor: 1 }, cuts)).toBe(18);
  });

  test("records above a closed segment's boundary have no virtual number", () => {
    expect(virtualCursor({ segment: 0, cursor: 11 }, cuts)).toBeUndefined();
  });

  test("positions compare lexicographically", () => {
    expect(
      comparePositions({ segment: 0, cursor: 99 }, { segment: 1, cursor: 1 }),
    ).toBeLessThan(0);
    expect(
      comparePositions({ segment: 1, cursor: 2 }, { segment: 1, cursor: 2 }),
    ).toBe(0);
  });

  test("a marker from a discarded fork branch is void", () => {
    const adopted: RoutingState = { active: "B", handoffFroms: ["dead"] };
    expect(segmentLocator(adopted, 0)).toBe("dead");
    expect(segmentLocator(adopted, 1)).toBe("B");
    expect(segmentLocator(adopted, 2)).toBeUndefined();
    expect(isVoidPosition({ segment: 1, cursor: 5 }, "C", adopted)).toBe(true);
    expect(isVoidPosition({ segment: 1, cursor: 5 }, "B", adopted)).toBe(false);
    expect(isVoidPosition({ segment: 0, cursor: 30 }, "dead", adopted)).toBe(
      false,
    );
  });
});

describe("§6.3 linking rule", () => {
  test("a chain has one tip; a merge joins concurrent tips", () => {
    const a = rec("a", 0, 1);
    const b = rec("b", 0, 2, ["a"]); // sender saw only a
    const c = rec("c", 0, 3, ["a"]); // concurrent sender also saw only a
    expect(tipsOf([a, b, c]).sort()).toEqual(["b", "c"]);

    const merge = rec("merge", 0, 4, ["b", "c"]);
    expect(tipsOf([a, b, c, merge])).toEqual(["merge"]);
    expect(adjudicate([a, b, c, merge], []).counted.has("a")).toBe(true);
  });

  test("unlinked legacy records each become a link target once, then tip counts collapse", () => {
    const legacy = [rec("l1", 0, 1), rec("l2", 0, 2), rec("l3", 0, 3)];
    expect(tipsOf(legacy)).toHaveLength(3);
    const catchingUp = rec("catchup", 0, 4, tipsOf(legacy));
    expect(tipsOf([...legacy, catchingUp])).toEqual(["catchup"]);
  });
});

describe("stress: randomized worlds (3 segments, 2 cuts, re-sends)", () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomWorld(seed: number): {
    records: HistoryRecord[];
    cuts: SegmentCut[];
    earlyIds: string[];
  } {
    const rand = mulberry32(seed);
    const records: HistoryRecord[] = [];
    const cursors: Record<number, number> = {};
    const nextCursor = (segment: number): number =>
      (cursors[segment] = (cursors[segment] ?? 0) + 1);
    const segCounts = [
      8 + Math.floor(rand() * 8),
      4 + Math.floor(rand() * 6),
      3 + Math.floor(rand() * 5),
    ];

    for (const [segment, count] of segCounts.entries()) {
      for (let i = 0; i < count; i += 1) {
        const cursor = nextCursor(segment);
        if (rand() < 0.15 && records.length > 0) {
          // Re-send: same envelope (same id and links) at a new position (§6.2).
          const source = records[Math.floor(rand() * records.length)]!;
          records.push({
            id: source.id,
            parents: source.parents,
            position: { segment, cursor },
          });
        } else {
          // 85% of senders follow §6.3 (link every known tip); the rest are
          // unlinked legacy records.
          const parents = rand() < 0.85 ? tipsOf(records) : [];
          records.push({
            id: `r${records.length}`,
            parents,
            position: { segment, cursor },
          });
        }
      }
    }

    // Cut k: the committer ingested a prefix of creation order ending
    // somewhere inside segment k.
    const cuts: SegmentCut[] = [];
    let start = 0;
    let lastCutIndex = 0;
    for (let k = 0; k < 2; k += 1) {
      const end = start + segCounts[k]! - 1;
      const sawIndex = start + 1 + Math.floor(rand() * (end - start + 1));
      const prefix = records.slice(0, sawIndex);
      cuts.push({
        boundaryCursor: prefix[prefix.length - 1]!.position.cursor,
        boundaryTips: tipsOf(prefix),
      });
      lastCutIndex = sawIndex;
      start = end + 1;
    }

    return {
      records,
      cuts,
      earlyIds: records.slice(0, lastCutIndex).map((record) => record.id),
    };
  }

  function sorted(set: Set<string>): string {
    return [...set].sort().join(",");
  }

  test("invariants hold across 300 random worlds", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const { records, cuts, earlyIds } = randomWorld(seed);
      const result = adjudicate(records, cuts);
      const parentsById = new Map(
        records.map((record) => [record.id, record.parents]),
      );
      const positionsById = new Map<string, Set<string>>();
      for (const record of records) {
        const key = `${record.position.segment}:${record.position.cursor}`;
        const bucket = positionsById.get(record.id) ?? new Set<string>();
        bucket.add(key);
        positionsById.set(record.id, bucket);
      }

      // I1: counted history is ancestor-closed (no counted record depends on
      // an orphan).
      for (const id of result.counted) {
        const queue = [...(parentsById.get(id) ?? [])];
        while (queue.length > 0) {
          const parent = queue.pop()!;
          if (!parentsById.has(parent)) continue;
          expect(result.counted.has(parent), `seed ${seed}: ${parent}`).toBe(
            true,
          );
          queue.push(...(parentsById.get(parent) ?? []));
        }
      }

      // I2: adjudication is order-independent, including re-sent duplicates.
      const rand = mulberry32(seed * 7919);
      for (let round = 0; round < 3; round += 1) {
        const shuffled = [...records].sort(() => rand() - 0.5);
        const other = adjudicate(shuffled, cuts);
        expect(sorted(other.counted)).toBe(sorted(result.counted));
        expect(sorted(other.orphaned)).toBe(sorted(result.orphaned));
      }

      // I3: no record is both counted and orphaned.
      for (const id of result.counted) {
        expect(result.orphaned.has(id)).toBe(false);
      }

      // I4: virtual numbering is collision-free over counted records at
      // their canonical positions.
      const virtuals = [...result.counted].map((id) => {
        const positions = [...(positionsById.get(id) ?? [])].map((key) => {
          const [segment, cursor] = key.split(":").map(Number);
          return { segment: segment!, cursor: cursor! };
        });
        return virtualCursor(canonicalPosition(positions), cuts);
      });
      const defined = virtuals.filter((value) => value !== undefined);
      expect(new Set(defined).size).toBe(defined.length);

      // I5: no false loss — everything the later committer ingested before
      // its cut is counted.
      for (const id of earlyIds) {
        expect(result.counted.has(id), `seed ${seed}: lost ${id}`).toBe(true);
      }
    }
  });
});
