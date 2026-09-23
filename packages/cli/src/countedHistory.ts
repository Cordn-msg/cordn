/**
 * Executable model of the counted-history rules of
 * `spec/applications/coordinator-handoff.md` (§4.4, §5, §6.2, §6.3, §7).
 *
 * Deliberately independent of MLS and coordinator code: it models the spec
 * text so the rules can be tested and stressed before the flows that consume
 * them exist. Where the model had to invent a rule not stated in the spec,
 * the test file records the finding.
 */

export interface Position {
  segment: number;
  cursor: number;
}

export interface HistoryRecord {
  /** Envelope `id` ([`spec/02.md`] §4) — the DAG node identity (§6.2). */
  id: string;
  /** Envelope `id` values named by `prev` tags. Empty = unlinked (§6.1). */
  parents: string[];
  position: Position;
}

/** The `HandoffRecord` fields that matter for adjudication (§4.4). */
export interface SegmentCut {
  boundaryCursor: number;
  boundaryTips: string[];
}

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
 * counted), `boundary_tips` of every cut, and legacy-tolerated unlinked
 * records at or below their segment's `boundary_cursor`. Entries whose
 * copies all lie in closed segments and fall outside that closure are
 * orphaned. Referenced ids nobody holds are gaps (§8). Duplicate copies of
 * one `id` (re-sends, §6.2) are one record.
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
    for (const position of entry.positions) {
      const cut = cuts[position.segment];
      if (cut === undefined) {
        seed(id); // any copy in the open segment: provisionally counted
        break;
      }
      if (entry.parents.length === 0 && position.cursor <= cut.boundaryCursor) {
        seed(id); // legacy tolerance (§7.1)
        break;
      }
    }
  }
  for (const cut of cuts) for (const tip of cut.boundaryTips) seed(tip);

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

/**
 * Dense virtual cursor for display (§5). Undefined for records of a closed
 * segment beyond its `boundary_cursor`.
 */
export function virtualCursor(
  position: Position,
  cuts: SegmentCut[],
): number | undefined {
  if (position.segment > cuts.length) return undefined;
  let base = 0;
  for (let segment = 0; segment < position.segment; segment += 1) {
    base += cuts[segment]!.boundaryCursor + 1;
  }
  const cut = cuts[position.segment];
  if (cut !== undefined && position.cursor > cut.boundaryCursor) {
    return undefined;
  }
  return base + position.cursor;
}

/** The locator the adopted chain assigns to a segment (§5). */
export function segmentLocator(
  state: RoutingState,
  segment: number,
): string | undefined {
  if (segment < state.handoffFroms.length) return state.handoffFroms[segment];
  return segment === state.handoffFroms.length ? state.active : undefined;
}

/**
 * A cursor reference whose accompanying locator is not the adopted chain's
 * locator for its segment is stale (e.g. minted on a discarded fork branch)
 * and void (§5).
 */
export function isVoidPosition(
  position: Position,
  locator: string,
  state: RoutingState,
): boolean {
  return segmentLocator(state, position.segment) !== locator;
}

/** The §4.4 chain rules: append iff `active` changes; `from` == previous
 *  active; never re-activate a coordinator that already served the group. */
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
      if (prev.handoffFroms.includes(cur.active)) {
        errors.push(
          `update ${i}: active re-activates a coordinator that already served the group`,
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
