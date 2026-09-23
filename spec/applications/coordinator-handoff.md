# Cordn Coordinator Handoff

- Status: Draft

## Abstract

This document defines how a `cordn` group survives its coordinator. It covers coordinator migration (planned handoff), coordinator loss (forced failover), and coordinator discovery (preferred coordinator and a preference-ordered fallback roster agreed in group state).

The design rests on three pieces. First, a `cordn_coordinator_routing` MLS GroupContext extension carrying the group's preferred coordinator, fallback roster, and append-only handoff chain. Second, causal `prev` links carried inside sealed message envelopes, over the envelope identifiers already defined in [`spec/02.md`](../02.md), giving the group a self-certifying history whose completeness and boundaries are verifiable without trusting any coordinator. Third, cursor positions qualified by segment, so per-group cursors remain meaningful across coordinators that do not share cursor spaces.

Coordinators are unchanged. They remain uniform, content-opaque delivery services as defined in [`spec/00.md`](../00.md) and [`spec/03.md`](../03.md); every mechanism in this document is client-side or group-state-side.

## Specification

### 1. Overview

`cordn` groups use exactly one active coordinator at a time.

- MLS requires strong ordering, so a group MUST NOT write to more than one coordinator concurrently (single-writer discipline).
- The active coordinator is agreed group state, carried in the `cordn_coordinator_routing` GroupContext extension (§4).
- A preference-ordered fallback roster accompanies the active coordinator so members can find the group after coordinator loss without out-of-band signals (§4.4).
- Switching coordinators is a *handoff*: it closes the current segment of the group's history and opens a new one (§9, §10).
- Cursor spaces are per coordinator. Positions across a handoff are made meaningful by segment qualification (§5) and by causal links (§6), not by cursor arithmetic.

This document adds no coordinator protocol surface. All fetch, store, and subscribe behavior is unchanged.

### 2. Terminology

- **Locator**: where a coordinator can be reached: its public key plus optional relay hints (§3).
- **Segment**: one contiguous stretch of the group's delivery stream as served by one coordinator. Segment indices are `0, 1, 2, …` in handoff order. Each segment has its own cursor space.
- **Position**: a pair `(segment, cursor)` naming a record's place in the group's history (§5).
- **Link**: a `prev` tag in a message envelope naming another record by envelope `id` (§6).
- **Tip**: a record whose `id` is not referenced as a link target by any known record.
- **Ancestors of a record**: the record itself and everything reachable from it by following links transitively.
- **Counted record**: a record that is part of the group's history (§7). A record that is not counted is **orphaned**.

### 3. Coordinator Locator

A coordinator locator has the same shape as the coordinator coordinates of a group reference ([`group-ref.md`](group-ref.md) TLV types 1 and 2):

```typescript
interface CoordinatorLocator {
  pubkey: string; // 32-byte coordinator public key, lowercase Nostr hex
  relays?: string[]; // relay URLs where the coordinator is reachable
}
```

Implementations MUST encode the public key as 32 raw bytes in serialized group state and use the lowercase hex form in textual and API representations, matching [`group-ref.md`](group-ref.md).

### 4. The `cordn_coordinator_routing` Extension

#### 4.1 Extension Identifier

Implementations MUST use a stable private-use MLS extension type for `cordn_coordinator_routing`.

This document assigns:

- `cordn_coordinator_routing = 0xC04E`

This value is in the MLS private-use extension range and MUST be advertised in member capabilities whenever a client claims support for this extension. Capability and admission rules mirror those of [`spec/01.md`](../01.md) §7: a group using this extension MUST ensure all members support it before adding them, and a client joining such a group MUST verify support before accepting the group state.

#### 4.2 TLS Serialization

The extension payload uses TLS presentation language with MLS variable-length vector encoding conventions, following [`spec/01.md`](../01.md) §3.

In TLS notation:

```tls
opaque Pubkey[32];
opaque RelayUrl<0..2^16-1>;
opaque EnvelopeId<0..2^16-1>;   // ASCII hex envelope id, 64 chars

struct {
    Pubkey pubkey;
    RelayUrl relay_urls<0..2^16-1>;
} CoordinatorLocator;

struct {
    CoordinatorLocator from;
    uint64 boundary_cursor;
    EnvelopeId boundary_tips<0..2^16-1>;
} HandoffRecord;

struct {
    uint16 version;
    CoordinatorLocator active;
    CoordinatorLocator fallbacks<1..2^16-1>;
    HandoffRecord handoffs<0..2^16-1>;
} CordnCoordinatorRouting;
```

All `EnvelopeId` values MUST be canonical envelope `id` strings as defined in [`spec/02.md`](../02.md) §4. All URLs MUST be valid UTF-8.

#### 4.3 Versioning

- Version `1` is the initial format defined by this document.
- Version `0` is reserved and MUST be rejected.
- Future versions MUST preserve append-only evolution by adding new fields only at the end of the structure.
- Implementations SHOULD ignore unknown trailing fields from future versions when this can be done safely.

#### 4.4 Field Semantics

- `active` is the group's current coordinator. It is the only coordinator the group writes to.
- `fallbacks` is the preference-ordered recovery roster. It MUST contain at least one locator. Members attempt fallbacks in order when the active coordinator is unreachable (§10).
- `handoffs` is the append-only handoff chain. Entry `k` closes segment `k`: `from` names segment `k`'s coordinator, `boundary_cursor` and `boundary_tips` mark the cut (§5, §7). The open segment has index `len(handoffs)` and is served by `active`.

Rules:

- Segment `k < len(handoffs)` is served by `handoffs[k].from`. Segment `0` at first installation is served by `handoffs[0].from` when the first entry records a migration into this extension, otherwise by the `active` at installation.
- A routing update MUST append a `HandoffRecord` if and only if `active` changes. Roster edits that leave `active` unchanged MUST NOT append a record or renumber segments.
- The `active` locator MUST NOT name a coordinator that already served the group (any `from` in `handoffs`). A returning service MUST use a fresh coordinator identity. This keeps every segment's cursor space fresh (records restart at cursor `1`) and every locator mapped to exactly one segment.
- The locator recorded in `from` of a new entry MUST equal the `active` of the previous extension state.
- `boundary_cursor` is the highest cursor of the closing segment that the committer had ingested at commit time.
- `boundary_tips` is the committer's tip set of the group's causal DAG at commit time (§6). It MAY be empty.

#### 4.5 Lifecycle and Updates

- The extension MAY be set at group creation or added, replaced, or removed by MLS `group_context_extensions` proposals and the commits that apply them, mirroring [`spec/01.md`](../01.md) §8.
- MLS GroupContext extension updates replace the full extension list, so senders updating this extension MUST preserve any other GroupContext extensions that remain in use.
- Implementations MUST serialize the complete `CordnCoordinatorRouting` structure on every update.

### 5. Segments and Cursor Positions

Cursors remain exactly as defined in [`spec/00.md`](../00.md) §4–§5: monotonic per group, scoped to one coordinator's view of the group's stream, never canonical message identities. This document adds that every cursor belongs to a **segment**.

- A position `(k, c)` names cursor `c` in segment `k`'s cursor space.
- Cursor values MUST NOT be compared or combined across segments except by comparing positions lexicographically: `(k, c) < (k', c')` iff `k < k'`, or `k = k'` and `c < c'`.
- A cursor reference that travels with a coordinator locator is implicitly qualified by that coordinator's segment. No format change is required:
  - the Welcome `after` hint ([`welcome-delivery.md`](welcome-delivery.md)) names a cursor of the segment whose coordinator stores the Welcome;
  - a group document's `cursor` ([`multi-device.md`](multi-device.md) §4) names a cursor of the segment whose coordinator the document names in its `coordinator` field;
  - client-local fetch progression and read markers name cursors of the segment the client is currently ingesting.
- A cursor reference with no accompanying locator, in a group with `len(handoffs) > 0`, is ambiguous and MUST NOT be used for comparison across segments.
- A cursor reference whose accompanying locator is not the one the adopted chain assigns to its segment — for example a marker minted on a discarded fork branch (§10) — is stale and MUST be treated as void.

Implementations MAY derive a dense virtual cursor numbering for display and compact storage:

- `base(0) = 0`; `base(k + 1) = base(k) + handoffs[k].boundary_cursor + 1`
- a record at position `(k, c)` with `c <= handoffs[k].boundary_cursor` displays as `base(k) + c`
- the handoff commit that appended `handoffs[k]` displays as `base(k + 1)` (the seam)
- records of a closed segment beyond `boundary_cursor` have no virtual number. They MAY still be counted through §7.1 pull-in; they simply display by position instead of by dense number

Virtual numbering is presentational. It MUST NOT be used to decide whether a record is counted (§7), and it MUST NOT appear on the wire as anything other than an ordinary cursor within one segment.

### 6. Causal Links and Message Identity

Causal links make history continuity verifiable without trusting coordinator cursor arithmetic.

#### 6.1 The `prev` Tag

A message envelope MAY carry one or more `prev` tags in its `tags` array ([`spec/02.md`](../02.md) §2, §6):

```json
"tags": [["prev", "<parent envelope id>"]]
```

- The tag name is `prev`. The tag value MUST be a valid envelope `id` ([`spec/02.md`](../02.md) §4) of another record of the same group.
- One tag MUST be used per linked record. Multiple `prev` tags indicate a tip merge.
- `prev` expresses delivery causality only. Application relationships such as replies and reactions continue to use NIP conventions as required by [`spec/02.md`](../02.md) §6.

#### 6.2 Node Identity

The node identity of a record in the causal DAG is the envelope `id` defined in [`spec/02.md`](../02.md) §4.

- Authors compute the `id` once at send time; receivers re-derive it as already required by [`spec/02.md`](../02.md) §4. No additional verification step is introduced.
- Because `tags` participates in the `id` derivation, the `id` commits to the record's link set: two records with the same `id` have the same parents. Author equivocation on the DAG is structurally impossible.
- Re-sending a lost record MUST reuse the original envelope and therefore its `id`, re-sealing only (fresh nonce, [`spec/03.md`](../03.md) §4). Receivers MUST deduplicate by `id`, so re-delivery, re-sending, and handoff overlap all collapse to one record.
- When the same `id` appears at multiple positions (a re-send landing in a later segment), it is one record, and the lowest position is canonical.

#### 6.3 Linking Rule

When sending a record, a sender MUST include one `prev` tag for every tip of its known DAG for the group.

- In the common case this is exactly one tag, naming the sender's latest ingested record. A client catching up on unlinked legacy records links each of them once, after which tip counts collapse back to one.
- After ingesting concurrent records, the sender's next record links all resulting tips, merging them. Linking only the latest tip would strand concurrent tips forever, so the rule is all tips, not one.
- A record with no `prev` tags is **unlinked**. Unlinked records are tolerated: they carry no causality information and are adjudicated by position alone (§7).

Links are carried inside the sealed payload ([`spec/03.md`](../03.md) §4). Coordinators see no link structure and gain no visibility into reply, merge, or interaction patterns.

### 7. Counted History, Orphans, and Commits

#### 7.1 Counted Records

A record of a closed segment `k` is **counted** if and only if either:

- it is an ancestor of one of `handoffs[k].boundary_tips`, or
- it becomes linked as an ancestor of any later counted record (pull-in), or
- it is unlinked and its cursor is at most `handoffs[k].boundary_cursor` (legacy tolerance).

Classification is provisional and grows with knowledge: an open-segment record is provisionally counted when received (and adjudication is not final at segment close, because later linkage can still pull records in), a segment's closing can orphan records the group never linked, and later linkage can pull records back in. All members holding the same records converge on the same classification. Clients MUST reconcile on change: a record that becomes counted MUST be ingested (re-fetched per §8 when no longer held), and a record that proves orphaned MUST be discarded (§7.2). Reclamation requires the relevant records; implementations bound retention as [`multi-device.md`](multi-device.md) document chains do, and a record that can no longer be recovered remains a gap (§8).

`boundary_cursor` is advisory for fetch bounding and display (§5). **Countedness is decided by linkage, never by cursor comparison.** A record above `boundary_cursor` can be pulled in by later linkage, and a record below it can be orphaned if never linked.

#### 7.2 Orphaned Records

A record of a closed segment that satisfies none of the §7.1 conditions is **orphaned**.

- Clients MUST NOT process records outside the counted set, even when fetched later.
- Classification can change as knowledge grows (§7.1). A client that processed a record before it proved orphaned MUST discard it; its content is not authoritative, and for Commits see §7.3. A client that discarded a record before it was pulled in MUST re-ingest it.
- Typical orphans: records written to a coordinator after the group stopped reading it (§9), and the unconfirmed tail of a coordinator that failed (§10). Orphaned records are precisely the records that never achieved inbound confirmation from any counted sender.

#### 7.3 Commits

MLS handshake records (Proposals and Commits) are not message envelopes and carry no `prev` links. They are adjudicated by the MLS epoch chain:

- a Commit is counted if and only if its resulting epoch lies in the epoch chain of the group's adopted MLS state (the transcript hash chains every Commit to its predecessors, [`RFC 9420`](https://www.rfc-editor.org/rfc/rfc9420));
- in a planned handoff, the commit carrying the routing update is by definition the final record of the closing segment;
- in a forced failover, the commit carrying the routing update is by definition the first counted record of the new segment;
- two competing Commits at the same epoch (possible only when failover or handoff commits race, §9, §10) are a fork of the same class as the known equal-epoch limitation of [`multi-device.md`](multi-device.md); healing follows that document's reconcile procedure, and the discarded branch's routing updates and segment never existed (§5 marks references to them void).

### 8. Gap Detection and Recovery

Links make missing history enumerable.

- When an ingested record links a `prev` id the client does not hold, that id is a **gap**. Clients SHOULD resolve gaps by fetching the affected segment ranges ([`spec/00.md`](../00.md) §5) and matching records by envelope `id` after decryption, and MAY request the record from any member holding it.
- Gap resolution MUST deduplicate by `id` (§6.2).
- A record that no reachable party holds is unrecoverable delivery history; this does not affect group state, which members hold independently and reconcile via [`multi-device.md`](multi-device.md).

### 9. Planned Handoff

A planned handoff moves the group to a new coordinator while the current one is still serving.

Procedure:

1. The group chooses the target locator by its application-level decision process.
2. The committing member ingests the closing segment to quiescence (fetch-first discipline; late records should be linked before the cut, §7.1 pull-in).
3. The committing member creates a `group_context_extensions` proposal and Commit replacing `cordn_coordinator_routing` with: `active` set to the target locator, `fallbacks` updated as desired, and a `HandoffRecord` appended with `from` equal to the previous `active`, `boundary_cursor` equal to the committer's highest ingested cursor of the closing segment, and `boundary_tips` equal to the committer's tip set.
4. The commit is posted to the **closing** segment's coordinator. It is the final record of that segment.
5. After the commit is stored, the sender and every member that processes it MUST NOT post further records to the closing segment. All subsequent records go to `active`, starting at that segment's cursor `1`.
6. Clients treat processing the routing commit as the segment switch: fetch progression for positions `(k, c)` maps to the closing coordinator with `afterCursor = c`, and for `(k + 1, c)` to the new `active` with `afterCursor = c`. The existing fetch-then-subscribe ingestion model ([`packages/cli/README.md`](../../packages/cli/README.md)) continues to apply per segment.
7. Non-message coordinator state is migrated per §11.

A straggler that misses the routing commit and posts to the closing segment produces an orphan candidate: the record can only become counted by the §7.1 pull-in rule, and it can never finalize a pending epoch operation, because inbound confirmation for it requires a fetch past a boundary that no compliant client performs. On catching up, the straggler retries its pending record on the new segment.

### 10. Forced Failover

A forced failover moves the group to a fallback coordinator after the active coordinator becomes unreachable.

Procedure:

1. Members determine unreachability by local policy (timeouts and retry counts are out of scope for this document).
2. Members attempt the `fallbacks` roster in preference order. All members SHOULD prefer the first reachable fallback, which concentrates handoff commits on one coordinator and lets that coordinator's ordering serialize them.
3. The first member to commit on the chosen fallback creates a `group_context_extensions` update: `active` set to the chosen fallback, `handoffs` appended with `from` equal to the unreachable coordinator's locator, `boundary_cursor` equal to the committer's highest ingested cursor of the dead segment, and `boundary_tips` equal to the committer's tip set.
4. The commit is posted to the **new** coordinator. It is the first counted record of the new segment. The old segment's cut is approximate: `boundary_cursor` and `boundary_tips` state what one member had confirmed, and §7.1 adjudicates the rest.
5. Every member adopts the routing commit on processing it and switches write targets (§9 step 6 for progression mapping).
6. Authors of records that never achieved inbound confirmation on the dead segment MAY re-send them on the new segment. Re-sends reuse the original envelope `id` and deduplicate (§6.2); unconfirmed Commits cannot be re-sent and are superseded by new Commits on the new segment.

Requirements and failure notes:

- Concurrent failover commits that land on the **same** fallback serialize into a linear handoff chain through that coordinator's ordering: the later commit, created after ingesting the earlier one, appends an ordinary subsequent `HandoffRecord` or merely edits the roster.
- Concurrent failover commits that land on **different** fallbacks fork the routing state. This is the same class as the known equal-epoch limitation of [`multi-device.md`](multi-device.md). Members MUST adopt the routing state carried by the MLS state they converge on per that document's reconcile procedure and MUST treat the discarded branch's segment as never having existed for positioning.
- The tail that existed only on the dead coordinator is lost. This is consistent with the storage model of [`spec/00.md`](../00.md): coordinators provide temporary storage, and durability of history is not a coordinator guarantee. Loss of unconfirmed application messages is acceptable; loss of group state is repaired via [`multi-device.md`](multi-device.md) document chains.

### 11. Non-Message Coordinator State

A coordinator also stores Welcomes, join requests, and published KeyPackages. This state does not migrate automatically; owners re-establish it on the active coordinator:

- **Welcomes**: Welcomes stranded on a former coordinator's queue are stale after a planned handoff and lost after a forced failover. Inviters SHOULD re-store pending Welcomes on the active coordinator. A re-stored Welcome's `after` hint MUST be minted as a cursor of the active segment (§5).
- **Join requests**: requesters whose pending request was stranded SHOULD re-submit it to the active coordinator ([`join-requests.md`](join-requests.md)).
- **KeyPackages**: publishers SHOULD re-publish their current KeyPackages to the active coordinator. Last-resort KeyPackages make this non-destructive ([`spec/00.md`](../00.md) §11).

Welcomes minted after the switch embed the group's MLS state and therefore the routing extension: an invitee learns the active coordinator and the full fallback roster before ever contacting a coordinator.

### 12. Interaction with Other Specifications

- [`spec/00.md`](../00.md): unchanged. Coordinator uniformity (§2), cursor semantics (§4–§5), and the migration slot reserved in §13 are as this document defines them.
- [`spec/01.md`](../01.md): `cordn_coordinator_routing` coexists with `cordn_group_metadata`; updates to either MUST preserve the other ([§4.5](#45-lifecycle-and-updates)).
- [`spec/02.md`](../02.md): the envelope `id` (§4) is DAG node identity; `prev` tags are ordinary tags (§6) and the existing mandatory `id` recomputation covers them. Envelope decoding is unaffected: `prev` is additive and unknown tags are preserved by conforming decoders.
- [`spec/03.md`](../03.md): unchanged. Links live inside the sealed payload; coordinators gain no visibility (§3, §6.3).
- [`group-ref.md`](group-ref.md): a group reference's coordinator coordinates are one locator (§3). A reference minted after a handoff SHOULD carry the active locator and MAY carry fallback relays as additional relay hints.
- [`welcome-delivery.md`](welcome-delivery.md): the `after` hint is a position (§5), implicitly scoped to the segment whose coordinator stores the Welcome.
- [`multi-device.md`](multi-device.md): the group document `cursor` is a position (§5), implicitly scoped to the segment named by the document's `coordinator` field. Its compare-and-advance rules (§8) apply within one segment; across segments, positions compare lexicographically. Fork healing continues to follow that document's reconcile procedure.
- [`join-requests.md`](join-requests.md): stranding and re-submission are as §11.

### 13. Worked Example

A group lives on coordinator A. Its stream is segment `0`, cursors `1..40`, where cursor 40 is a planned handoff commit to coordinator B with `boundary_cursor = 39` and `boundary_tips = [<id at (0, 37)>]`.

- A chat message at `(0, 12)` displays (optionally) as virtual `12`.
- The handoff commit at `(0, 40)` is the seam and displays as virtual `40` (`base(1) = 0 + 39 + 1`).
- B serves segment `1` from cursor `1`; its first chat message `(1, 1)` displays as virtual `41`.
- A message written to A at cursor 41 after the cut is fetched later: it is orphaned (not linked by `boundary_tips`, not pulled in) and MUST NOT be processed. It has no virtual number.
- A message that a slow member wrote to A at cursor 38 before the cut, which the committer had not ingested, is pulled in when the author's next record on B links its `id`. It is counted at `(0, 38)`, virtual `38`.

### 14. Interoperability Requirements

Implementations MUST agree on all of the following:

- the `cordn_coordinator_routing` extension type value, serialization, and versioning rules
- the `prev` tag name, one-parent-per-tag shape, and the linking rule of §6.3
- envelope `id` semantics from [`spec/02.md`](../02.md) §4 as DAG node identity, including deduplication on re-send and the canonical (lowest) position rule of §6.2
- segment numbering, position comparison, the implicit qualification rule for cursor references that travel with a locator, and the stale-marker void rule of §5
- the counted/orphaned adjudication of §7 and the commit rules of §7.3
- the planned handoff and forced failover procedures of §9 and §10, including the single-writer discipline

Implementations MUST reject malformed extension payloads, invalid UTF-8, and `prev` values that are not valid envelope ids. An extension update that violates the chain rules of §4.4 MUST be treated as void rather than applied; such an update can only arrive from a discarded fork branch (§7.3), and the §4.4 rules remain the conformance target for update authors.

### 15. Rationale

The design keeps coordinators dumb and moves all survivability into group state and client-side verification.

- **One active coordinator at a time.** MLS needs a total order; multiple concurrent coordinators would assign incomparable cursors and fork group state. A single writer with sequential segments is the simplest structure that preserves strong ordering.
- **Preferred coordinator and fallback roster in group state.** Group state is agreed through MLS, so nobody can unilaterally redirect the group. The roster is required because of the discovery paradox: updating group state to say where the group went requires a coordinator, so after coordinator *loss* the metadata cannot name the recovery target. The roster is recovery state agreed *before* the disaster. Preferring the first reachable fallback also concentrates racing failover commits on one coordinator, where ordering serializes them.
- **Causal links over cursor arithmetic.** Dense offset schemes (continuing one coordinator's numbering on the next) require knowing the exact last cursor assigned before the cut. That number is unknowable after a crash, so offsets either collide (two records claiming one position, silently skipping fetches) or gap unpredictably. Link-based adjudication is exact under the same races: a record is counted because someone counted links it, and the pull-in rule of §7.1 covers the ordinary straggler without losing messages. This replaces trust in cursor bookkeeping with verifiable ancestry.
- **Envelope `id` as node identity.** It is computed once by the author and mandatorily re-derived by receivers today ([`spec/02.md`](../02.md) §4), so the DAG inherits verification for free. It is content-derived, so a re-send of a lost record after re-sealing keeps its identity and deduplicates — where a hash over the sealed blob would differ on every fresh nonce. And it never surfaces outside the seal, so coordinators cannot even compute the DAG's node identities.
- **Links in `tags`.** Tags are the designated extension point of the envelope ([`spec/02.md`](../02.md) §6), they are covered by the `id` derivation (same id ⇒ same link set), and conforming decoders carry them through untouched. This makes the mechanism strictly additive: pre-feature clients keep verifying records fully and simply ignore causality.
- **Positions instead of global cursors.** Cursors are already per-group and coordinator-local ([`spec/00.md`](../00.md) §4). Qualifying them by segment preserves every existing wire format; because each durable cursor reference in the protocol already travels alongside a coordinator locator, qualification is implicit and no format changes are required anywhere.
- **Orphans are evidence-based.** The old instinct — cap fetches at a cursor and hope — is trust in the switcher's arithmetic. Ancestry makes orphanhood provable, and it coincides exactly with the existing finalization rule: orphaned records are precisely those that never achieved inbound confirmation.
- **Provisional classification with reconcile-on-change.** Rare boundary races reclassify records in both directions (a straggler orphaned at the cut, then pulled in by its author's next record). Accepting reclassification buys convergence: every member holding the same records computes the same history, with no permanent disagreement about stragglers.
- **No consensus over the DAG.** The DAG expresses causality; ordering remains the coordinator's job. A fork-choice rule over links would be a second consensus mechanism duplicating the single-writer discipline. The residual race — two handoff commits at the same epoch on different coordinators — is inherited openly from the known [`multi-device.md`](multi-device.md) limitation and healed by the same procedure.

This approach makes coordinator loss a routing event with verifiable boundaries rather than a data-loss event for group state, at the cost of one small optional tag, one optional GroupContext extension, and no coordinator changes.
