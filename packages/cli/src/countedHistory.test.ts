import { describe, expect, test } from "vitest";

import {
  adjudicate,
  canonicalPosition,
  chainLocators,
  checkRoutingChain,
  comparePositions,
  isVoidMarker,
  tipsOf,
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

/** A cut is just the committer's tip set (§4.4 `boundary_tips`). */
function cut(...tips: string[]): SegmentCut {
  return tips;
}

describe("spec §13 worked example", () => {
  const root = rec("root", 0, 30); // unlinked; the committer knew it, so it is one of its tips
  const r36 = rec("r36", 0, 36);
  const r37 = rec("r37", 0, 37, ["r36"]);
  const slow = rec("slow", 0, 38, ["r37"]); // written before the cut, not ingested by the committer
  const late = rec("late", 0, 41, ["r37"]); // written after the cut
  const next = rec("next", 1, 1, ["slow"]); // author's first record on the new segment
  const cut0 = cut("r37", "root"); // the committer's tips: its whole knowledge

  const result = adjudicate([root, r36, r37, slow, late, next], [cut0]);

  test("late write to the closed segment is orphaned", () => {
    expect(result.orphaned.has("late")).toBe(true);
    expect(result.counted.has("late")).toBe(false);
  });

  test("pre-cut record pulled in by later linkage is counted at (0, 38)", () => {
    expect(result.counted.has("slow")).toBe(true);
  });

  test("boundary tips and their ancestors are counted; no gaps", () => {
    expect(result.counted.has("r37")).toBe(true);
    expect(result.counted.has("r36")).toBe(true);
    expect([...result.gaps]).toEqual([]);
  });

  test("a root the committer knew counts: it sits in the boundary tips itself", () => {
    expect(result.counted.has("root")).toBe(true);
  });
});

describe("§7.1/§7.2 adjudication rules", () => {
  test("open-segment records are provisionally counted", () => {
    const result = adjudicate([rec("o", 1, 5, ["tip"])], [cut("tip")]);
    expect(result.counted.has("o")).toBe(true);
    expect(result.orphaned.size).toBe(0);
  });

  test("an unlinked record outside the cut closure is orphaned (§7.1)", () => {
    const result = adjudicate(
      [rec("tip", 0, 30), rec("root", 0, 35)],
      [cut("tip")],
    );
    expect(result.counted.has("tip")).toBe(true);
    expect(result.orphaned.has("root")).toBe(true);
  });

  test("pull-in is transitive across segments", () => {
    const x = rec("x", 0, 19);
    const a = rec("a", 0, 20, ["x"]);
    const b = rec("b", 0, 21, ["a"]);
    const c = rec("c", 1, 1, ["b"]); // open segment: seeds the pull-in
    const result = adjudicate([x, a, b, c], [cut()]);
    expect(result.counted.has("b")).toBe(true); // direct parent of an open record
    expect(result.counted.has("a")).toBe(true); // transitive
    expect(result.counted.has("x")).toBe(true);
  });

  test("missing parents and unknown boundary tips are gaps (§8)", () => {
    const result = adjudicate([rec("x", 1, 1, ["ghost"])], [cut("phantom")]);
    expect([...result.gaps].sort()).toEqual(["ghost", "phantom"]);
    expect(result.counted.has("x")).toBe(true);
  });

  test("classification is provisional: counted → orphaned → counted as knowledge grows (§7.1)", () => {
    const s = rec("s", 0, 25);
    // Live receipt while the segment is open: provisionally counted.
    expect(adjudicate([s], []).counted.has("s")).toBe(true);
    // The cut closes without it and nothing links it: orphaned (discard).
    const closing = adjudicate([s], [cut()]);
    expect(closing.orphaned.has("s")).toBe(true);
    // Its author's next record pulls it back in: counted again (re-ingest).
    const pulled = adjudicate([s, rec("n", 1, 1, ["s"])], [cut()]);
    expect(pulled.counted.has("s")).toBe(true);
  });
});

describe("§10 forced failover and forks", () => {
  test("adopting one racing cut orphans the rival's exclusive records; later linkage rescues them", () => {
    const x = rec("x", 0, 5); // only committer 1 had ingested it
    const y = rec("y", 0, 6); // only committer 2 had ingested it
    // The two commits raced at the same epoch; the group adopts commit 1.
    const adopted = adjudicate([x, y], [cut("x")]);
    expect(adopted.counted.has("x")).toBe(true);
    expect(adopted.orphaned.has("y")).toBe(true);
    // A later record linking y pulls it back in (§7.1).
    const rescued = adjudicate([x, y, rec("n", 1, 1, ["y"])], [cut("x")]);
    expect(rescued.counted.has("y")).toBe(true);
    expect(rescued.counted.has("n")).toBe(true);
  });

  test("recovering one dead-tail record recovers its ancestry (§10)", () => {
    const c = rec("c", 0, 20); // the failover committer's tip: all it confirmed
    const u = rec("u", 0, 28); // dead tail, unlinked
    const t1 = rec("t1", 0, 29); // dead tail
    const t2 = rec("t2", 0, 30, ["t1"]);
    const n = rec("n", 1, 1, ["t2"]); // first record on the fallback links the tail
    const result = adjudicate([c, u, t1, t2, n], [cut("c")]);
    expect(result.counted.has("c")).toBe(true);
    expect(result.counted.has("t2")).toBe(true);
    expect(result.counted.has("t1")).toBe(true); // ancestry recovered by one link
    expect(result.orphaned.has("u")).toBe(true); // unlinked tail stays orphaned
  });
});

describe("§6.2 re-sent identity", () => {
  test("a re-sent id is one record at its canonical (lowest) position, in any arrival order", () => {
    const original = rec("m", 0, 5);
    const copy = rec("m", 1, 2);
    const cut0 = cut();

    const first = adjudicate([original, copy], [cut0]);
    const second = adjudicate([copy, original], [cut0]);

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

  test("returning to a previous coordinator is allowed: a fresh segment and stream (§4.4, §5)", () => {
    expect(
      checkRoutingChain([
        { active: "A", handoffFroms: [] },
        { active: "B", handoffFroms: ["A"] },
        { active: "A", handoffFroms: ["A", "B"] },
      ]),
    ).toEqual([]);
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

describe("§5 positions and stale markers", () => {
  test("positions compare lexicographically", () => {
    expect(
      comparePositions({ segment: 0, cursor: 99 }, { segment: 1, cursor: 1 }),
    ).toBeLessThan(0);
    expect(
      comparePositions({ segment: 1, cursor: 2 }, { segment: 1, cursor: 2 }),
    ).toBe(0);
  });

  test("a marker from a discarded fork branch is void; one naming a chain locator is not", () => {
    const adopted: RoutingState = { active: "B", handoffFroms: ["dead"] };
    expect(chainLocators(adopted)).toEqual(["dead", "B"]);
    expect(isVoidMarker("C", adopted)).toBe(true);
    expect(isVoidMarker("B", adopted)).toBe(false);
    expect(isVoidMarker("dead", adopted)).toBe(false);
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

  test("unlinked records each become a link target once, then tip counts collapse", () => {
    const roots = [rec("l1", 0, 1), rec("l2", 0, 2), rec("l3", 0, 3)];
    expect(tipsOf(roots)).toHaveLength(3);
    const catchingUp = rec("catchup", 0, 4, tipsOf(roots));
    expect(tipsOf([...roots, catchingUp])).toEqual(["catchup"]);
  });
});

describe("stress: randomized worlds (3 segments, 2 cuts)", () => {
  interface Profile {
    label: string;
    link: number; // senders following §6.3
    resend: number; // re-sent envelopes (§6.2)
    drop: number; // records lost before anyone ingested them (§8 gaps)
  }

  const profiles: Profile[] = [
    { label: "compliant", link: 1, resend: 0, drop: 0 },
    { label: "noisy", link: 0.85, resend: 0.15, drop: 0 },
    { label: "chaotic", link: 0.5, resend: 0.4, drop: 0.1 },
  ];

  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomWorld(
    seed: number,
    profile: Profile,
  ): {
    records: HistoryRecord[];
    droppedIds: Set<string>;
    cuts: SegmentCut[];
    rivalCuts: SegmentCut[];
    earlyIds: string[];
  } {
    const rand = mulberry32(seed);
    const all: HistoryRecord[] = [];
    const cursors: Record<number, number> = {};
    // Fresh numbering per segment (§5): a returning coordinator restarts.
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
        if (rand() < profile.resend && all.length > 0) {
          // Re-send: same envelope (same id and links) at a new position (§6.2).
          const source = all[Math.floor(rand() * all.length)]!;
          all.push({
            id: source.id,
            parents: source.parents,
            position: { segment, cursor },
          });
        } else {
          // Compliant senders link every known tip (§6.3); the rest send
          // unlinked records (DAG roots).
          const parents = rand() < profile.link ? tipsOf(all) : [];
          all.push({
            id: `r${all.length}`,
            parents,
            position: { segment, cursor },
          });
        }
      }
    }

    // Dropped records never reach any holder; ids others link become gaps.
    const droppedIds = new Set(
      [...new Set(all.map((record) => record.id))].filter(
        () => rand() < profile.drop,
      ),
    );
    const records = all.filter((record) => !droppedIds.has(record.id));

    // Cut k: the committer ingested a prefix of creation order ending
    // somewhere inside segment k. The cut is its tip set (§4.4).
    const cuts: SegmentCut[] = [];
    const rivalCuts: SegmentCut[] = [];
    let start = 0;
    let lastCutIndex = 0;
    for (let k = 0; k < 2; k += 1) {
      const end = start + segCounts[k]! - 1;
      const sawIndex = start + 1 + Math.floor(rand() * (end - start + 1));
      cuts.push(cut(...tipsOf(records.slice(0, sawIndex))));
      // A racing committer at the same epoch with a slightly different view.
      const rivalIndex = start + 1 + Math.floor(rand() * (end - start + 1));
      rivalCuts.push(cut(...tipsOf(records.slice(0, rivalIndex))));
      lastCutIndex = sawIndex;
      start = end + 1;
    }

    return {
      records,
      droppedIds,
      cuts,
      rivalCuts,
      earlyIds: records.slice(0, lastCutIndex).map((record) => record.id),
    };
  }

  function sorted(set: Set<string>): string {
    return [...set].sort().join(",");
  }

  function expectClosedAndDisjoint(
    result: Adjudication,
    parentsById: Map<string, string[]>,
    seed: number,
  ): void {
    // Counted history is ancestor-closed (no counted record depends on an
    // orphan) and no record is both counted and orphaned.
    for (const id of result.counted) {
      expect(result.orphaned.has(id), `seed ${seed}: both ${id}`).toBe(false);
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
  }

  test("invariants hold across 900 random worlds (compliant → chaotic)", () => {
    for (let i = 0; i < 900; i += 1) {
      const profile = profiles[i % profiles.length]!;
      const seed = 1 + Math.floor(i / profiles.length);
      const { records, droppedIds, cuts, rivalCuts, earlyIds } = randomWorld(
        seed,
        profile,
      );
      const result = adjudicate(records, cuts);
      const parentsById = new Map(
        records.map((record) => [record.id, record.parents]),
      );

      // I1 + I3: closure and disjointness.
      expectClosedAndDisjoint(result, parentsById, seed);

      // I2: adjudication is order-independent, including re-sent duplicates.
      const rand = mulberry32(seed * 7919);
      for (let round = 0; round < 3; round += 1) {
        const shuffled = [...records].sort(() => rand() - 0.5);
        const other = adjudicate(shuffled, cuts);
        expect(sorted(other.counted)).toBe(sorted(result.counted));
        expect(sorted(other.orphaned)).toBe(sorted(result.orphaned));
      }

      // I4: no false loss — everything the later committer ingested before
      // its cut is counted.
      for (const id of earlyIds) {
        expect(result.counted.has(id), `seed ${seed}: lost ${id}`).toBe(true);
      }

      // I5: a fork's losing branch is equally coherent under the same rules
      // (adopting the rival committer's cut set keeps the invariants).
      const rival = adjudicate(records, rivalCuts);
      expectClosedAndDisjoint(rival, parentsById, seed);

      // I6: holes are visible gaps (§8), never silent holes in counted sets.
      for (const id of result.counted) {
        for (const parent of parentsById.get(id) ?? []) {
          if (droppedIds.has(parent)) {
            expect(result.gaps.has(parent), `seed ${seed}: gap ${parent}`).toBe(
              true,
            );
          }
        }
      }
      for (const gap of result.gaps) {
        expect(parentsById.has(gap), `seed ${seed}: ${gap} held`).toBe(false);
      }
    }
  });
});
