/**
 * Executable model of the counted-history rules of
 * `spec/applications/coordinator-handoff.md` (§4.4, §5, §6.2, §6.3, §7).
 *
 * Deliberately independent of MLS and coordinator code: it models the spec
 * text so the rules can be tested and stressed before the flows that consume
 * them exist. Where the model had to invent a rule not stated in the spec,
 * the test file records the finding.
 */

/**
 * A record's place in history (§5). Cursors restart per segment — a
 * coordinator serving the group again opens a fresh numbering space — so
 * `(segment, cursor)` is unambiguous and order is lexicographic.
 */
export interface Position {
  segment: number;
  cursor: number;
}

export interface HistoryRecord {
  /** Envelope `id` ([`spec/02.md`] §4) — the DAG node identity (§6.2). */
  id: string;
  /** Envelope `id` values named by `prev` tags. Empty = a DAG root (§6.3). */
  parents: string[];
  position: Position;
}

/**
 * A closing commit's `boundary_tips` (§4.4) — the committer's tip set. Its
 * ancestor closure is exactly what that member had ingested (§7.1).
 */
export type SegmentCut = string[];

/** The routing fields that matter for the §4.4 chain rules. */
export interface RoutingState {
  active: string;
  /** `from` locator of each handoff record, in segment order. */
  handoffFroms: string[];
}

export interface Adjudication {
  counted: Set<string>;
  orphaned: Set<string>;
  gaps: Set<string>;
}

/** Positions compare lexicographically (§5). */
export function comparePositions(a: Position, b: Position): number {
  return a.segment !== b.segment ? a.segment - b.segment : a.cursor - b.cursor;
}

/** A record appearing at multiple positions canonically sits at the lowest (§6.2). */
export function canonicalPosition(positions: Position[]): Position {
  return positions.reduce((best, candidate) =>
    comparePositions(candidate, best) < 0 ? candidate : best,
  );
}

/** Tip = id not referenced as a link target by any known record (§2). */
export function tipsOf(records: Iterable<HistoryRecord>): string[] {
  const all = new Map<string, HistoryRecord>();
  for (const record of records) all.set(record.id, record);
  const referenced = new Set<string>();
  for (const record of all.values()) {
    for (const parent of record.parents) referenced.add(parent);
  }
  return [...all.keys()].filter((id) => !referenced.has(id));
}

interface Entry {
  parents: string[];
  positions: Position[];
}

/**
 * Counted/orphaned adjudication (§7.1, §7.2). Counted history is the
 * ancestor-closure of the seeds: open-segment records (provisionally
 * counted) and the `boundary_tips` of every cut. Entries whose copies all
 * lie in closed segments and fall outside that closure are orphaned.
 * Referenced ids nobody holds are gaps (§8). Duplicate copies of one `id`
 * (re-sends, §6.2) are one record. Cursor values never decide anything.
 */
export function adjudicate(
  records: Iterable<HistoryRecord>,
  cuts: SegmentCut[],
): Adjudication {
  const entries = new Map<string, Entry>();
  for (const record of records) {
    const entry = entries.get(record.id);
    if (entry === undefined) {
      entries.set(record.id, {
        parents: record.parents,
        positions: [record.position],
      });
    } else {
      entry.positions.push(record.position);
    }
  }

  const counted = new Set<string>();
  const gaps = new Set<string>();

  const seed = (id: string) => {
    if (entries.has(id)) counted.add(id);
    else gaps.add(id);
  };

  for (const [id, entry] of entries) {
    if (
      entry.positions.some((position) => cuts[position.segment] === undefined)
    ) {
      seed(id); // any copy in the open segment: provisionally counted
    }
  }
  for (const tips of cuts) for (const tip of tips) seed(tip);

  // Pull-in: ancestors of counted records are counted (§7.1).
  const queue = [...counted];
  while (queue.length > 0) {
    const entry = entries.get(queue.pop()!)!;
    for (const parent of entry.parents) {
      if (entries.has(parent)) {
        if (!counted.has(parent)) {
          counted.add(parent);
          queue.push(parent);
        }
      } else {
        gaps.add(parent);
      }
    }
  }

  const orphaned = new Set<string>();
  for (const [id, entry] of entries) {
    const allCopiesClosed = entry.positions.every(
      (position) => cuts[position.segment] !== undefined,
    );
    if (allCopiesClosed && !counted.has(id)) orphaned.add(id);
  }
  return { counted, orphaned, gaps };
}

/** Every locator that served or serves the group (§5). */
export function chainLocators(state: RoutingState): string[] {
  return [...state.handoffFroms, state.active];
}

/**
 * A cursor reference whose accompanying locator does not appear in the
 * adopted chain is stale (e.g. minted on a discarded fork branch) and void
 * (§5).
 */
export function isVoidMarker(locator: string, state: RoutingState): boolean {
  return !chainLocators(state).includes(locator);
}

/** The §4.4 chain rules: append iff `active` changes; `from` == previous active. */
export function checkRoutingChain(states: RoutingState[]): string[] {
  const errors: string[] = [];
  for (let i = 1; i < states.length; i += 1) {
    const prev = states[i - 1]!;
    const cur = states[i]!;
    if (cur.active !== prev.active) {
      if (cur.handoffFroms.length !== prev.handoffFroms.length + 1) {
        errors.push(
          `update ${i}: active changed without exactly one appended handoff record`,
        );
      } else if (
        cur.handoffFroms[cur.handoffFroms.length - 1] !== prev.active
      ) {
        errors.push(
          `update ${i}: handoff record 'from' must equal the previous active locator`,
        );
      }
    } else if (cur.handoffFroms.length !== prev.handoffFroms.length) {
      errors.push(
        `update ${i}: active unchanged, so the handoff chain must not change`,
      );
    }
  }
  return errors;
}
