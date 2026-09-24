/**
 * Executable model of the counted-history rules of
 * `spec/applications/coordinator-handoff.md` (§4.4, §5, §6.2, §6.3, §7).
 *
 * Deliberately independent of MLS and coordinator code: it models the spec
 * text so the rules can be tested and stressed before the flows that consume
 * them exist. Where the model had to invent a rule not stated in the spec,
 * the test file records the finding.
 */

export interface HistoryRecord {
  /** Envelope `id` ([`spec/02.md`] §4) — the DAG node identity (§6.2). */
  id: string;
  /** Envelope `id` values named by `prev` tags. Empty = a DAG root (§6.3). */
  parents: string[];
  /**
   * The stream this copy was fetched from (§2), as the ordinal of the
   * segment whose coordinator served the fetch. Provenance is the only
   * cursor-derived fact adjudication uses: whether the copy came from the
   * stream serving the open segment (§7.1 provisional seeds).
   */
  stream: number;
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
  streams: number[];
}

/**
 * Counted/orphaned adjudication (§7.1, §7.2). Counted history is the
 * ancestor-closure of the seeds: every `boundary_tips` entry of every cut
 * and every record fetched from the stream serving the open segment
 * (provisionally counted). Everything else held is orphaned. Referenced ids
 * nobody holds are gaps (§8). Duplicate copies of one `id` (re-sends, §6.2)
 * are one record. Cursor values never decide anything.
 */
export function adjudicate(
  records: Iterable<HistoryRecord>,
  cutTips: Iterable<string>,
  activeStream: number,
): Adjudication {
  const entries = new Map<string, Entry>();
  for (const record of records) {
    const entry = entries.get(record.id);
    if (entry === undefined) {
      entries.set(record.id, {
        parents: record.parents,
        streams: [record.stream],
      });
    } else {
      entry.streams.push(record.stream);
    }
  }

  const counted = new Set<string>();
  const gaps = new Set<string>();

  const seed = (id: string) => {
    if (entries.has(id)) counted.add(id);
    else gaps.add(id);
  };

  for (const [id, entry] of entries) {
    if (entry.streams.includes(activeStream)) {
      seed(id); // any copy from the open stream: provisionally counted
    }
  }
  for (const tip of cutTips) seed(tip);

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
  for (const id of entries.keys()) {
    if (!counted.has(id)) orphaned.add(id);
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
