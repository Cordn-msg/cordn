# Cordn Coordinator Handoff

- Status: Draft

## Abstract

This document defines how a `cordn` group survives its coordinator. It covers coordinator migration (planned handoff), coordinator loss (forced failover), and coordinator discovery (preferred coordinator and a preference-ordered fallback roster agreed in group state).

The design rests on two pieces. First, a `coordinator_routing` field of the cordn group metadata document carrying the group's preferred coordinator, fallback roster, and append-only handoff chain. Second, causal `prev` links carried inside sealed message envelopes, over the envelope identifiers already defined in [`spec/02.md`](../02.md), giving the group a self-certifying history whose completeness and boundaries are verifiable without trusting any coordinator. Cursors stay exactly as [`spec/00.md`](../00.md) defines them — stream-local addresses — and are given no cross-stream meaning.

Coordinators are unchanged. They remain uniform, content-opaque delivery services as defined in [`spec/00.md`](../00.md) and [`spec/03.md`](../03.md); every mechanism in this document is client-side or group-state-side.

## Specification

### 1. Overview

`cordn` groups use exactly one active coordinator at a time.

- MLS requires strong ordering, so a group MUST NOT write to more than one coordinator concurrently (single-writer discipline).
- The active coordinator is agreed group state, carried in the group metadata document's `coordinator_routing` field (§4).
- A preference-ordered fallback roster accompanies the active coordinator so members can find the group after coordinator loss without out-of-band signals (§4.4).
- Switching coordinators is a *handoff*: it closes the current segment of the group's history and opens a new one (§9, §10).
- Cursor spaces are per coordinator and are given no cross-stream meaning. History identity and continuity come from causal links (§6), never from cursor arithmetic (§5).

This document adds no coordinator protocol surface. All fetch, store, and subscribe behavior is unchanged.

### 2. Terminology

- **Locator**: where a coordinator can be reached: its public key plus optional relay hints (§3).
- **Stream**: one `gid`'s cursor space on one coordinator for one segment. Cursors are assigned by that coordinator and never renumbered within a stream. A coordinator serving the group again opens a new stream for the client (§5).
- **Segment**: one contiguous stretch of the group's history served under one active coordinator. Segment indices are `0, 1, 2, …` in handoff order. A segment has exactly one stream (§5).
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

### 4. Coordinator Routing State

#### 4.1 Placement in the Group Metadata Document

Routing state is the first trailing field appended to the `CordnGroupMetadata` structure ([`spec/01.md`](../01.md) §3): an optional `coordinator_routing` field carrying the `CordnCoordinatorRouting` structure of [§4.2](#42-tls-serialization). Encoders MUST always write the field (empty when no routing state is present) so that fields appended by future versions keep their position.

No new extension type, capability advertisement, or admission rule is introduced: the field rides the existing `cordn_group_metadata` GroupContext extension (`0xC04D`, [`spec/01.md`](../01.md) §2), whose capability and admission rules are unchanged. Decoders that do not recognize the field MUST ignore it ([`spec/01.md`](../01.md) §4 trailing-field rule); a client that does not understand coordinator handoff simply does not follow it (§14).

#### 4.2 TLS Serialization

The `coordinator_routing` field payload uses TLS presentation language with MLS variable-length vector encoding conventions, following [`spec/01.md`](../01.md) §3.

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

- Version `1` is the initial format defined by this document. Versioning follows [`spec/01.md`](../01.md) §4 exactly: version `0` is reserved and MUST be rejected, evolution is append-only at the end of the structure, and unknown trailing fields SHOULD be ignored when this can be done safely.

#### 4.4 Field Semantics

- `active` is the group's current coordinator. It is the only coordinator the group writes to.
- `fallbacks` is the preference-ordered recovery roster. It MUST contain at least one locator. Members attempt fallbacks in order when the active coordinator is unreachable (§10).
- `handoffs` is the append-only handoff chain. Entry `k` closes segment `k`: `from` names segment `k`'s coordinator and `boundary_tips` marks the cut (§7). The open segment has index `len(handoffs)` and is served by `active`.

Rules:

- A routing update MUST append a `HandoffRecord` if and only if `active` changes. Roster edits that leave `active` unchanged MUST NOT append a record or renumber segments.
- A locator MAY appear several times in the chain: each appearance is a fresh segment on a fresh stream, even for a coordinator the group used before (§5).
- The locator recorded in `from` of a new entry MUST equal the `active` of the previous routing state.
- `boundary_tips` is the committer's tip set of the group's causal DAG at commit time (§6). It MAY be empty.

#### 4.5 Lifecycle and Updates

Lifecycle follows [`spec/01.md`](../01.md) §8: the metadata document MAY be set at group creation or updated by `group_context_extensions` proposals and the commits that apply them. Each update MUST serialize the complete metadata document — including a complete `CordnCoordinatorRouting` structure whenever routing state is present, never a partial chain — and MUST preserve any other GroupContext extensions that remain in use.

### 5. Streams and Cursors

Cursors remain exactly as defined in [`spec/00.md`](../00.md) §4–§5: monotonic per group, scoped to one coordinator's view of the group's stream, never canonical message identities. Cursors are stream-local addresses and nothing more: they order records within one stream and never carry meaning across streams.

- A stream is one `gid`'s cursor space on one coordinator, and it serves exactly one segment. A coordinator serving the group again opens a **new stream** for the client even though its own numbering continues: coordinators stay dumb, numbering monotonically per `gid` and never learning about segments (a stream MAY be discarded by the coordinator, [`spec/00.md`](../00.md)). Stream identity and fetch progression are therefore client-side facts: a client stamps each fetched record with the stream of the segment its binding serves, and re-reads of already-held records deduplicate by `id` (§6.2). A record left on a closed stream while the group was elsewhere is past that stream's cut (§13): a re-read MAY pick it up provisionally, and the next cut adjudicates it — members converge at the cut (§7.1), and §8 recovery covers anything uncounted.
- Cursor values MUST NOT be compared or combined across streams. Within one stream, order is cursor order.
- A cursor reference MUST travel with its locator, which names the stream. No format change is required:
  - the Welcome `after` hint ([`welcome-delivery.md`](welcome-delivery.md)) names a cursor of the stream whose coordinator stores the Welcome;
  - a group document's `cursor` ([`multi-device.md`](multi-device.md) §4) names a cursor of the stream whose coordinator the document names in its `coordinator` field;
  - client-local fetch progression and read markers name cursors of the stream the client is currently ingesting.
- A cursor reference with no locator in a group with `len(handoffs) > 0`, or whose locator does not appear in the adopted chain — for example a marker minted on a discarded fork branch (§10) — is void.

There is deliberately no numbering or ordering across streams: history identity and order come from the link chain (§6), and display order across streams is client-local.

### 6. Causal Links and Message Identity

Causal links make history continuity verifiable without trusting coordinator cursor arithmetic.

#### 6.1 The `prev` Tag

Message envelopes carry causal links as one or more `prev` tags in the `tags` array ([`spec/02.md`](../02.md) §2, §6):

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

#### 6.3 Linking Rule

When sending a record, a sender MUST include one `prev` tag for every tip of its known DAG for the group.

- In the common case this is exactly one tag, naming the sender's latest ingested record.
- After ingesting concurrent records, the sender's next record links all resulting tips, merging them. Linking only the latest tip would strand concurrent tips forever, so the rule is all tips, not one.
- A record with no `prev` tags is a DAG root — for example the group's first record — and is a tip until something links it. It is adjudicated like any other record (§7).

Links are carried inside the sealed payload ([`spec/03.md`](../03.md) §4). Coordinators see no link structure and gain no visibility into reply, merge, or interaction patterns.

### 7. Counted History, Orphans, and Commits

#### 7.1 Counted Records

A record is **counted** if and only if it lies in the ancestor closure of the counted seeds:

- every `boundary_tips` entry of every `handoffs` record, and
- every record fetched from the stream serving the open segment (provisional seeds).

Everything else a client holds is **orphaned** (§7.2). The closure of one cut's tips is exactly the cutting committer's knowledge: `boundary_tips` is that member's tip set, and the ancestor closure of a tip set is everything its holder knew — linked records walk back through their ancestors, and records with no `prev` tags are themselves tips. Any cut's tips may pull a record in, and any counted record links its ancestors in with it. **Countedness is decided by linkage and stream provenance, never by cursor values.**

Classification is provisional and grows with knowledge: a record fetched from the open stream is provisionally counted (and adjudication is not final at segment close, because later linkage can still pull records in), a segment's closing can orphan records the group never linked, and later linkage can pull records back in. All members holding the same records converge on the same classification. Clients MUST reconcile on change: a record that becomes counted MUST be ingested (re-fetched per §8 when no longer held), and a record that proves orphaned MUST be discarded (§7.2). Reclamation requires the relevant records; implementations bound retention as [`multi-device.md`](multi-device.md) document chains do, and a record that can no longer be recovered remains a gap (§8).

#### 7.2 Orphaned Records

A record is **orphaned** when it is not counted (§2, §7.1).

- Clients MUST NOT process records outside the counted set, even when fetched later.
- Classification can change as knowledge grows (§7.1). A client that processed a record before it proved orphaned MUST discard it; its content is not authoritative, and for Commits see §7.3. A client that discarded a record before it was pulled in MUST re-ingest it.
- Typical orphans: records written to a coordinator after the group stopped reading it (§9), and the unconfirmed tail of a coordinator that failed (§10). Orphaned records are precisely the records that never achieved inbound confirmation from any counted sender.

#### 7.3 Commits

MLS handshake records (Proposals and Commits) are not message envelopes and carry no `prev` links. They are adjudicated by the MLS epoch chain:

- a Commit is counted if and only if its resulting epoch lies in the epoch chain of the group's adopted MLS state (the transcript hash chains every Commit to its predecessors, [`RFC 9420`](https://www.rfc-editor.org/rfc/rfc9420));
- in a planned handoff, the commit carrying the routing update is by definition the final record of the closing segment;
- in a forced failover, the commit carrying the routing update is by definition the first counted record of the new segment;
- two competing Commits at the same epoch fork the group — the known equal-epoch limitation of [`multi-device.md`](multi-device.md); §10 defines how handoff and failover forks resolve.

### 8. Gap Detection and Recovery

Links make missing history enumerable. Gaps are soft: they report missing history and never gate processing.

- When an ingested record links a `prev` id the client does not hold, that id is a **gap**. Clients SHOULD resolve gaps by fetching the affected segment ranges ([`spec/00.md`](../00.md) §5) and matching records by envelope `id` after decryption, and MAY request the record from any member holding it.
- Gap resolution MUST deduplicate by `id` (§6.2).
- A counted record with gaps in its ancestry is still processed as soon as it is decryptable: decryption depends only on the MLS epoch a record belongs to and the epoch state the member holds, never on link continuity. A client MUST NOT withhold a counted record while a gap is unresolved; classification remains provisional and reconciles on change (§7.1). Handshake records are excepted: Commits still apply in epoch order.
- Recovery has two independent tracks. **History gaps** are resolved as above. **Epoch gaps** — a record that will not decrypt at any held epoch — mean missing handshake records: clients recover the affected Commits from the streams or from members, then retry. A decryption attempt is a cheap probe for which track is stalled, and clients MAY use it as one.
- A record that no reachable party holds is unrecoverable delivery history; this does not affect group state, which members hold independently and reconcile via [`multi-device.md`](multi-device.md).

### 9. Planned Handoff

A planned handoff moves the group to a new coordinator while the current one is still serving.

Procedure:

1. The group chooses the target locator by its application-level decision process.
2. The committing member ingests the closing segment to quiescence (fetch-first discipline; late records should be linked before the cut, §7.1 pull-in).
3. The committing member creates a `group_context_extensions` proposal and Commit replacing the group metadata document's `coordinator_routing` field with: `active` set to the target locator, `fallbacks` updated as desired, and a `HandoffRecord` appended with `from` equal to the previous `active` and `boundary_tips` equal to the committer's tip set.
4. The commit is posted to the **closing** segment's coordinator. It is the final record of that segment.
5. After the commit is stored, the sender and every member that processes it MUST NOT post further records to the closing segment. All subsequent records go to `active`, appended to that coordinator's stream: numbering starts at cursor `1` for every new segment (§5).
6. Clients treat processing the routing commit as the segment switch: fetch progression follows the new stream (§5). The existing fetch-then-subscribe ingestion model ([`packages/cli/README.md`](../../packages/cli/README.md)) continues to apply per stream.
7. Non-message coordinator state is migrated per §11.

A straggler that misses the routing commit and posts to the closing segment produces an orphan candidate: the record can only become counted by the §7.1 pull-in rule, and it can never finalize a pending epoch operation, because inbound confirmation for it requires ingesting past the cut, which no compliant client performs. On catching up, the straggler retries its pending record on the new segment.

### 10. Forced Failover

A forced failover moves the group to a fallback coordinator after the active coordinator becomes unreachable.

Procedure:

1. Members determine unreachability by local policy (timeouts and retry counts are out of scope for this document).
2. Members attempt the `fallbacks` roster in preference order. All members SHOULD prefer the first reachable fallback, which concentrates handoff commits on one coordinator and lets that coordinator's ordering serialize them.
3. The first member to commit on the chosen fallback creates a `group_context_extensions` update: `active` set to the chosen fallback, `handoffs` appended with `from` equal to the unreachable coordinator's locator and `boundary_tips` equal to the committer's tip set.
4. The commit is posted to the **new** coordinator. It is the first counted record of the new segment. The old segment's cut is approximate: `boundary_tips` states what one member had confirmed, and §7.1 adjudicates the rest.
5. Every member adopts the routing commit on processing it and switches write targets (§9 step 6 for the stream switch).
6. Authors of records that never achieved inbound confirmation on the dead segment MAY re-send them on the new segment. Re-sends reuse the original envelope `id` and deduplicate (§6.2); unconfirmed Commits cannot be re-sent and are superseded by new Commits on the new segment.

Requirements and failure notes:

- Concurrent failover commits that land on the **same** fallback serialize into a linear handoff chain through that coordinator's ordering: the later commit, created after ingesting the earlier one, appends an ordinary subsequent `HandoffRecord` or merely edits the roster.
- Concurrent failover commits that land on **different** fallbacks fork the routing state. This is the same class as the known equal-epoch limitation of [`multi-device.md`](multi-device.md). Members MUST adopt the routing state carried by the MLS state they converge on per that document's reconcile procedure and MUST treat the discarded branch's segment as never having existed; §5 voids references to its stream.
- The tail that existed only on the dead coordinator is lost. This is consistent with the storage model of [`spec/00.md`](../00.md): coordinators provide temporary storage, and durability of history is not a coordinator guarantee. Loss of unconfirmed application messages is acceptable; loss of group state is repaired via [`multi-device.md`](multi-device.md) document chains.

### 11. Non-Message Coordinator State

A coordinator also stores Welcomes, join requests, and published KeyPackages. This state does not migrate automatically; owners re-establish it on the active coordinator:

- **Welcomes**: Welcomes stranded on a former coordinator's queue are stale after a planned handoff and lost after a forced failover. Inviters SHOULD re-store pending Welcomes on the active coordinator. A re-stored Welcome's `after` hint MUST be minted as a cursor of the active stream (§5).
- **Join requests**: requesters whose pending request was stranded SHOULD re-submit it to the active coordinator ([`join-requests.md`](join-requests.md)).
- **KeyPackages**: publishers SHOULD re-publish their current KeyPackages to the active coordinator. Last-resort KeyPackages make this non-destructive ([`spec/00.md`](../00.md) §11).

Welcomes minted after the switch embed the group's MLS state and therefore the routing state: an invitee learns the active coordinator and the full fallback roster before ever contacting a coordinator.

### 12. Interaction with Other Specifications

- [`spec/00.md`](../00.md): unchanged. Coordinator uniformity (§2), cursor semantics (§4–§5), and the migration slot reserved in §13 are as this document defines them.
- [`spec/01.md`](../01.md): `coordinator_routing` is a trailing field of the `CordnGroupMetadata` structure defined there; its append-only evolution and ignore-trailing rules (§4) give pre-feature clients the ignore-and-continue behavior of §14.
- [`spec/02.md`](../02.md): the envelope `id` (§4) is DAG node identity; `prev` tags are ordinary tags (§6) and the existing mandatory `id` recomputation covers them. Envelope decoding is unaffected: `prev` is additive and unknown tags are preserved by conforming decoders.
- [`spec/03.md`](../03.md): unchanged. Links live inside the sealed payload; coordinators gain no visibility (§3, §6.3).
- [`group-ref.md`](group-ref.md): a group reference's coordinator coordinates are one locator (§3). A reference minted after a handoff SHOULD carry the active locator and MAY carry fallback relays as additional relay hints.
- [`welcome-delivery.md`](welcome-delivery.md): the `after` hint is a cursor of the stream whose coordinator stores the Welcome (§5).
- [`multi-device.md`](multi-device.md): the group document `cursor` is a cursor of the stream named by the document's `coordinator` field (§5). Its compare-and-advance rules (§8) apply within one stream; there is no cross-stream cursor comparison. Fork healing continues to follow that document's reconcile procedure.
- [`join-requests.md`](join-requests.md): stranding and re-submission are as §11.

### 13. Worked Example

A group lives on coordinator A. Its stream is segment `0`, cursors `1..40`, where cursor 40 is a planned handoff commit to coordinator B carrying `boundary_tips = [<id at A-cursor 37>]` — the committer's tips, whose ancestor closure is everything that committer had ingested.

- A chat message sits at A-cursor 12.
- The handoff commit is the seam at A-cursor 40.
- B serves segment `1` on its own stream; its first chat message is at B-cursor 1.
- A message written to A at cursor 41 after the cut is fetched later: its stream is no longer open and nothing counted links it, so it is orphaned and MUST NOT be processed.
- A message that a slow member wrote to A at cursor 38 before the cut, which the committer had not ingested, is pulled in when the author's next record on B links its `id`. It is counted.
- An older record with no `prev` tags that the committer had ingested is a tip, so it appears in `boundary_tips` itself and is counted.

### 14. Interoperability Requirements

Implementations MUST agree on all of the following:

- the `coordinator_routing` field's placement in the metadata document, serialization, and versioning rules
- the `prev` tag name, one-parent-per-tag shape, and the linking rule of §6.3
- envelope `id` semantics from [`spec/02.md`](../02.md) §4 as DAG node identity, including deduplication on re-send (§6.2)
- stream-local cursor semantics, the rule that cursor references travel with their locator, and the stale-stream void rule of §5
- the counted/orphaned adjudication of §7 and the commit rules of §7.3
- the planned handoff and forced failover procedures of §9 and §10, including the single-writer discipline

Implementations MUST reject malformed routing payloads, invalid UTF-8, and `prev` values that are not valid envelope ids. An extension update that violates the chain rules of §4.4 MUST be treated as void rather than applied; such an update can only arrive from a discarded fork branch (§7.3), and the §4.4 rules remain the conformance target for update authors.

### 15. Rationale

The design keeps coordinators dumb and moves all survivability into group state and client-side verification.

- **One active coordinator at a time.** MLS needs a total order; multiple concurrent coordinators would assign incomparable cursors and fork group state. A single writer with sequential segments is the simplest structure that preserves strong ordering.
- **Preferred coordinator and fallback roster in group state.** Group state is agreed through MLS, so nobody can unilaterally redirect the group. The roster is required because of the discovery paradox: updating group state to say where the group went requires a coordinator, so after coordinator *loss* the metadata cannot name the recovery target. The roster is recovery state agreed *before* the disaster. Preferring the first reachable fallback also concentrates racing failover commits on one coordinator, where ordering serializes them.
- **No new mandatory feature.** Routing extends the existing group metadata document instead of adding a GroupContext extension type: MLS makes every GroupContext extension mandatory for all members ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420) §13.4), so a new type would gate key packages and admission. As a trailing metadata field, handoff inherits the capability story the metadata extension already has, and clients that predate the fields simply do not follow them.
- **Causal links over cursor arithmetic.** Dense offset schemes (continuing one coordinator's numbering on the next) require knowing the exact last cursor assigned before the cut. That number is unknowable after a crash, so offsets either collide (two records claiming one position, silently skipping fetches) or gap unpredictably. Link-based adjudication is exact under the same races: a record is counted because someone counted links it, and the pull-in rule of §7.1 covers the ordinary straggler without losing messages. This replaces trust in cursor bookkeeping with verifiable ancestry.
- **Correlation is advisory; decryption is epoch-local.** The DAG decides what counts and what is missing (§7, §8), never whether a record can be opened: an application record decrypts at its own epoch even across gaps, so counted records are processed optimistically, and a decryption attempt doubles as a cheap probe that distinguishes history gaps from epoch gaps in recovery.
- **Envelope `id` as node identity.** It is computed once by the author and mandatorily re-derived by receivers today ([`spec/02.md`](../02.md) §4), so the DAG inherits verification for free. It is content-derived, so a re-send of a lost record after re-sealing keeps its identity and deduplicates — where a hash over the sealed blob would differ on every fresh nonce. And it never surfaces outside the seal, so coordinators cannot even compute the DAG's node identities.
- **Links in `tags`.** Tags are the designated extension point of the envelope ([`spec/02.md`](../02.md) §6), they are covered by the `id` derivation (same id ⇒ same link set), and conforming decoders carry them through untouched. This makes the mechanism strictly additive: pre-feature clients keep verifying records fully and simply ignore causality.
- **Stream-local cursors, no global numbering.** Cursors are already per-group and coordinator-local ([`spec/00.md`](../00.md) §4). The design assigns them no cross-stream meaning at all: history identity and order come from the link chain, so there is no numbering to maintain, translate, or compare — and every durable cursor reference in the protocol already travels alongside a coordinator locator, so no format changes are required anywhere. With no cursor arithmetic anywhere in the design, a returning coordinator's continuing numbering (§5) is harmless. Stragglers left on a closed stream and re-read when the group returns to that coordinator are provisionally counted at worst and adjudicated at the next cut (§5) — a deliberate correlation ceiling, with a coordinator-side numbering reset as the upgrade path if the wire ever grows one.
- **Orphans are evidence-based.** The old instinct — cap fetches at a cursor and hope — is trust in the switcher's arithmetic. Ancestry makes orphanhood provable, and it coincides exactly with the existing finalization rule: orphaned records are precisely those that never achieved inbound confirmation.
- **Provisional classification with reconcile-on-change.** Rare boundary races reclassify records in both directions (a straggler orphaned at the cut, then pulled in by its author's next record). Accepting reclassification buys convergence: every member holding the same records computes the same history, with no permanent disagreement about stragglers.
- **No consensus over the DAG.** The DAG expresses causality; ordering remains the coordinator's job. A fork-choice rule over links would be a second consensus mechanism duplicating the single-writer discipline. The residual race — two handoff commits at the same epoch on different coordinators — is inherited openly from the known [`multi-device.md`](multi-device.md) limitation and healed by the same procedure.

This approach makes coordinator loss a routing event with verifiable boundaries rather than a data-loss event for group state, at the cost of one small optional tag, one optional metadata field, and no coordinator changes.
