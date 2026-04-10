# Protocol Viability Assessment for Marmot

## Status

`draft` `informational`

This document records a candid technical assessment of Marmot's current direction. It is not normative protocol text. Its purpose is to explain where Marmot appears viable, where it appears overstated, and which unresolved issues could make the protocol ecosystem increasingly fragile if they remain unaddressed.

This document is intentionally more direct than the main specification. It is written to help contributors decide whether Marmot is on a path that can realistically lead to a robust interoperable protocol, or whether the current direction is accumulating unresolved technical debt faster than it is reducing risk.

## Why This Document Exists

Marmot combines MLS with Nostr relays. That design is attractive because it seeks strong end-to-end security without a trusted central messaging server. It is also unusually demanding because MLS expects a group to converge on one shared epoch history, while Nostr relays provide only weak ordering, partial visibility, and a public event surface.

Over time, several concerns have become harder to dismiss as isolated implementation mistakes:

- repeated evidence that weak relay ordering creates real branch and drift hazards,
- high-level privacy claims that are stronger than the actual transport privacy Marmot can provide on public relays,
- denial-of-service and adversarial resilience issues created by the public relay model,
- and a gap between Marmot's interoperability narrative and the amount of convergence behavior that is actually specified.

The goal of this document is not to argue that Marmot is impossible. The goal is to assess whether Marmot is currently moving in a healthy direction, and to explain why continued optimism without stronger specification work may cause the ecosystem to grow ill over time.

## Executive Judgment

The short version is:

- Marmot is not obviously impossible.
- Marmot's current cryptographic direction is meaningful.
- Marmot's current operational and privacy narrative is too optimistic.
- Marmot's pure decentralized profile is viable only with much stronger acknowledgment of its limits and much clearer convergence guidance.
- If the protocol continues growing without addressing these issues explicitly, the ecosystem is likely to become progressively more fragile, harder to interoperate, and more painful to correct later.

The core risk is not that Marmot fails suddenly. The core risk is that it keeps growing while under-specifying the exact parts that weakly ordered public transport makes operationally critical.

## Main Thesis

Marmot is decentralized in trust, but it is not coordination-free, metadata-private in the strong sense, or naturally resilient against adversarial public relay conditions.

If Marmot continues to describe itself in terms that suggest otherwise, then the project risks accumulating narrative debt and protocol debt at the same time.

That combination is dangerous because:

- users build expectations the system cannot reliably satisfy,
- implementers infer local behavior that is not sufficiently specified,
- mixed-client ecosystems become harder to keep convergent,
- and adversarial or merely noisy environments can degrade usability far more than the protocol story suggests.

## What Marmot Gets Right

This assessment is not purely negative. Marmot does have real strengths:

- MLS is a strong cryptographic basis for content confidentiality, authentication, forward secrecy, and post-compromise security.
- Nostr provides a decentralized dissemination layer without requiring a trusted central server for content access.
- The protocol can plausibly support a useful decentralized messaging profile if its limits are stated honestly and its operational requirements are strengthened.

The problem is therefore not that Marmot has no sound ideas. The problem is that the protocol's most difficult constraints sit exactly at the boundary between MLS and Nostr, and that boundary still appears under-specified and under-acknowledged.

## Challenge 1: Coordination Is Not Optional

### The Fundamental Issue

MLS is transport-agnostic, but it is not convergence-agnostic. It assumes group members will eventually agree on a single epoch progression. In practice, centralized or strongly coordinated deployments make this much easier by serializing commits, rejecting stale writes, and ensuring broad visibility of the chosen branch.

Marmot does not get those properties from Nostr relays for free.

Nostr relays are a dissemination substrate, not an ordering oracle. They do not provide a global commit order, global visibility, or certainty that all relevant participants have seen the same branch before more actions are taken.

That means Marmot cannot be safely treated as "MLS over a different transport" in a casual sense. It requires additional convergence discipline above the cryptographic protocol.

### Why This Matters in Practice

Without stronger coordination guidance, the following situations remain realistic:

- a newly joined member processes a valid Welcome but acts from stale visible state,
- an offline member comes back and creates new state before bounded catch-up,
- multiple admins create structurally valid competing Commits for the same epoch,
- different implementations make slightly different choices around sequencing, bundling, retries, or conflict handling,
- and losing branches still produce artifacts that later poison client behavior.

These are not merely theoretical race conditions. They are normal distributed-systems outcomes in a weakly ordered environment.

### Why "Implementation Bug" Is Not a Complete Answer

A recurring temptation is to frame observed drift as an implementation bug rather than a protocol issue. Sometimes that is true. But in an interoperable ecosystem, repeated failure modes caused by stale state, branch uncertainty, or ambiguous client behavior are not safely dismissed as local mistakes.

If the protocol depends on clients behaving conservatively under uncertainty, and that behavior is not made sufficiently explicit, then the protocol itself is underspecified.

The more implementations Marmot has, the less safe it becomes to rely on shared intuition instead of normative or near-normative operational guidance.

### Consequence if Unaddressed

If Marmot keeps its current direction without stronger convergence semantics, then the likely long-term outcome is not immediate collapse but chronic branch fragility:

- sporadic join failures,
- hard-to-reproduce local drift,
- mixed-client incompatibilities,
- user-visible message loss or undecryptable epochs,
- and a growing dependence on unwritten implementation folklore.

That is how protocol ecosystems become operationally sick.

## Challenge 2: Privacy Claims Are Stronger Than the Actual Privacy Model

### Content Privacy Is Real

Marmot does provide real content confidentiality. MLS protects group content from non-members, and the additional ChaCha20-Poly1305 envelope on `kind: 445` events adds defense in depth. Gift-wrapping also prevents some outer-layer disclosure for Welcome delivery.

These are meaningful properties.

### Metadata Privacy Is Limited

The problem is that Marmot operates over public Nostr relays where encrypted events are still hosted, replicated, queryable, and persistently collectable by anyone.

Even when observers cannot read message content, they can often still learn or infer:

- that Marmot is being used,
- that a particular group identifier is active,
- message timing and burst patterns,
- approximate message sizes,
- rough distinctions between message classes or state changes,
- relay overlap and possible group relationships,
- and, for relay operators, IP and connection metadata.

This is already broadly acknowledged in `threat_model.md`, but the high-level project narrative still tends to sound stronger than these realities justify.

### Public Persistence Changes the Threat Model

Public relay persistence means encrypted artifacts can be collected at scale and retained indefinitely.

That does not nullify MLS. It does mean the security story must account for capture-now, analyze-later behavior as a default condition rather than an exceptional one. It also means that implementation mistakes, key retention mistakes, weak operational practices, future cryptographic advances, or future device compromise become more consequential because the ciphertext corpus is easy to archive in bulk.

### Why This Matters

If Marmot continues to describe itself as strongly metadata-protecting while relying on public relays, then users and implementers may make choices based on a stronger privacy model than the system actually offers.

That is especially concerning in high-risk contexts where metadata is operationally more sensitive than content.

### Consequence if Unaddressed

If these limitations remain under-emphasized, the ecosystem risks building privacy expectations that later fail under ordinary relay observation, traffic analysis, or archival collection.

The result is not just technical debt. It is trust debt.

## Challenge 3: Adversarial Resilience Is Weaker Than the Architecture Suggests

### Public Stable Group Routing Creates a Spam Surface

Marmot uses public relay infrastructure and stable public routing identifiers such as the `nostr_group_id` carried in `kind: 445` `h` tags. This creates a practical attack surface.

An attacker does not need to break MLS to make the system painful to operate. They only need to observe the public group identifier and begin publishing junk `kind: 445` events with valid-looking routing information.

Even if those events do not decrypt, they still impose cost.

### Why The Cost Is Real

To distinguish real messages from garbage, clients may need to:

- download the event,
- parse it,
- attempt the outer decryption path,
- possibly attempt MLS parsing or validation,
- and only then conclude that it is junk.

At scale, this becomes a meaningful resource burden, especially on mobile devices or in low-bandwidth settings.

This is not just a nuisance. It affects:

- battery,
- CPU,
- bandwidth,
- storage pressure,
- UI responsiveness,
- and reliability of background processing.

### Real Messages Can Be Buried

The attacker does not need perfect cryptographic mimicry. Flooding relays with enough junk can bury valid traffic in noise, overwhelm client processing queues, and make the observable relay stream less usable.

In effect, the protocol's public addressability can be turned into a denial-of-service amplifier against specific groups.

### Relay Defenses Are Not a Complete Answer

It is tempting to point to relay spam controls such as NIP-13 or NIP-42. Those may help in some deployments, but they do not solve the whole problem for Marmot's current public-relay model:

- not all relays enforce them,
- public-relay interoperability reduces how much any one relay policy can be assumed,
- proof-of-work can be asymmetrically painful for constrained clients,
- and a design that relies on open relay visibility still leaves broad room for abuse.
- NIP-42 is not a viable solution since it's current model doesn't allow the authentication model that marmot needs.

So while relay-level mitigations are useful, they do not remove the architectural exposure created by public stable group routing on weakly controlled relays.

### Consequence if Unaddressed

If Marmot does not more directly account for adversarial spam and relay flooding, then clients may remain theoretically secure but operationally brittle. In real deployments, that can be enough to make the system effectively unusable under sustained attack.

## Challenge 4: Recovery and Failure Semantics Remain Too Soft

Distributed systems do not only need happy-path rules. They need rules for uncertainty, ambiguity, losing branches, stale local state, and irrecoverable inconsistency.

Marmot has some local rules already, but the protocol still appears too weak on questions like:

- when a client must defer sending because local state is uncertain,
- how a newly joined client should treat post-Welcome uncertainty,
- what it means to quarantine a suspicious branch,
- what clients should do when same-epoch branch competition remains unresolved locally,
- and when re-invitation or resync is required instead of repeated optimism.

Without stronger recovery semantics, clients tend to improvise. In a single implementation that may be survivable. In a multi-implementation ecosystem it becomes an interop risk.

## Challenge 5: Large-Scale and Multi-Implementation Reality Is Harder Than the Current Story

Marmot is often discussed in terms of interoperability and generality, but those ambitions increase the importance of the protocol issues above.

The more Marmot grows toward:

- multiple implementations,
- mobile-first clients,
- larger groups,
- more concurrent admins,
- and more varied relay topologies,

the more dangerous it becomes to leave convergence and failure behavior underspecified.

Something that works in a tightly controlled environment with a small number of implementations does not automatically become a robust decentralized protocol. It may instead just be surviving on shared assumptions that have not yet been forced to break.

## On `epoch_authenticator` This can also be used for safer roll backs in case of corrupted state

One useful line of research is whether MLS's `epoch_authenticator` can be used as a cheap, RFC-aligned same-epoch consistency signal, especially for Welcome-path branch reasoning.

This is attractive because it is:

- already part of MLS semantics,
- low overhead,
- useful for distinguishing normal successful joins from suspicious or misbound successful joins,
- and compatible with a fail-closed model when mismatches are observed.

It is important not to oversell it.

`epoch_authenticator` is not a replacement for MLS validation. It does not prove global convergence, and it does not rescue structurally invalid Welcome processing. Its value is narrower: it can provide an efficient cross-check that inviter and joiner derived the same welcome-epoch state in scenarios where weak ordering, raced branches, buggy behavior, or adversarial metadata claims are realistic.

Whether Marmot adopts it or not, the larger point remains: the protocol needs better consistency reasoning than it currently exposes.

## What Happens If Marmot Continues In The Same Direction

If Marmot keeps growing without tightening its coordination model, privacy language, and adversarial resilience assumptions, the most likely outcome is not dramatic failure but progressive ecosystem illness.

That illness would probably look like this:

- the protocol keeps sounding simpler and more private than it really is,
- the flagship applications remain fragile in ways that are hard for users to understand,
- new implementations rediscover the same edge cases and drift hazards,
- maintainers classify too many operational failures as local bugs instead of protocol obligations,
- public-relay abuse and message burying remain an under-modeled cost,
- and eventually compatibility depends more on shared folklore than on the specification.

At that stage, fixing the protocol becomes more painful because the ecosystem has already grown around ambiguous behavior.

## What Would Need To Change

For Marmot to remain a good long-term bet, several things would need to become more explicit.

### 1. Narrow the privacy claims

The protocol and project documentation should clearly distinguish:

- content confidentiality,
- metadata minimization,
- and strong metadata privacy.

Marmot can honestly claim the first. It can partially claim the second. It should be very careful about implying the third on public relays.

### 2. Strengthen convergence guidance

The protocol should more clearly define:

- post-join catch-up expectations,
- pre-Commit freshness checks,
- stale-state deferral,
- drift containment behavior,
- and conservative handling under same-epoch uncertainty.

This does not require a full protocol-defined global state machine. It does require stronger operational semantics.

### 3. Specify better recovery behavior

The protocol should fail closed more explicitly when clients encounter drift, inconsistent Welcome-path evidence, ratchet-tree failures, or unresolved branch ambiguity.

### 4. Model adversarial relay conditions more seriously

The public relay threat model should more directly account for:

- targeted junk message injection,
- per-group message burying,
- client resource exhaustion from decrypt-to-discard workloads,
- and the practical limits of relay-side spam protection.

### 5. Be more honest about the pure decentralized profile

The protocol should clearly state that a pure decentralized deployment can be valid while still having hard limits:

- no global certainty,
- no guaranteed complete visibility,
- no perfect stale-writer prevention,
- limited metadata privacy on public relays,
- and increasing fragility as concurrency and scale rise.

That honesty would strengthen Marmot, not weaken it.

## Final Assessment

Marmot is not necessarily a dead protocol. But it is at real risk of becoming a chronically unhealthy one if it continues to accumulate growth without equivalent growth in specification honesty and operational rigor.

The cryptography is not the main problem. The main problem is the combination of:

- weakly ordered public dissemination,
- optimistic privacy framing,
- under-specified convergence behavior,
- soft failure and recovery semantics,
- and a public attack surface that can impose real operational cost without breaking encryption.

If these issues are acknowledged and addressed, Marmot may still evolve into a useful decentralized messaging protocol with realistic security boundaries.

If they are not, then Marmot risks becoming a protocol that is impressive in concept, frustrating in practice, and increasingly expensive to save.