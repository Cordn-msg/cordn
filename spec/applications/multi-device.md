# Cordn Multi-Device Synchronization

- Status: Draft

## Abstract

This document defines how `cordn` clients keep multiple devices of one identity synchronized without server-side key material or coordinator changes. Devices of a single user share one MLS leaf (one `ClientState` per group). They converge on application messages and third-party Commits by replaying the same opaque delivery stream defined in [`spec/03.md`](../03.md), and converge on sibling-device Commits by replaying a chain of per-epoch `ClientState` snapshots carried in sealed *session documents* linked by `prev` — because a sibling's Commit cannot be ingested from the stream. Each document is stored as a content-addressed blob, addressed by `sha256` of the sealed blob, and advertised through a mutable, opaque tip pointer whose transport hides the owner's identity and `cordn` usage from passive observers. The coordinator is unchanged: it continues to treat group messages as opaque bytes, as required by [`spec/03.md`](../03.md).

This document specifies the session document format, the sealed-document content-protection model, the seed-not-merge reconciliation rule, a tombstone model for group removal (§8), the cursor semantics that let a freshly-seeded device catch up, a RECOMMENDED hardened tip transport, and a connection-string device-addition flow. On-device MLS state storage is out of scope; alternative tip transports remain interoperable because the tip is a lookup.

## Specification

### 1. Overview

Multi-device reuses the delivery model of [`spec/03.md`](../03.md) for a separate concern: converging per-group client state across devices of one identity.

- A user's devices share a single MLS leaf per group: one `ClientState`, one membership, one set of per-epoch secrets.
- Application messages and Commits authored by other members converge via the per-group ordered delivery stream. A Commit authored by a sibling device (same leaf) does NOT: the committing device re-publishes, and siblings fast-forward their `ClientState` to the newer epoch from the document.
- A sealed *session document* snapshots each group's MLS state and delivery cursor. It seeds groups a device lacks, advertises which groups exist, converges group state, and propagates group removals across devices (§8).
- The document is encrypted (sealed) to the owner's own Nostr public key, stored on a content-addressed store chosen by the client, and addressed by `sha256` of the sealed blob. [Blossom](https://github.com/hzrd149/blossom) is RECOMMENDED.
- A mutable, opaque *tip* (§6) advertises the current document address. Devices fetch the tip, verify the owner-signed pointer it carries, fetch the document, decrypt, and reconcile.

This keeps the trust boundary established by [`spec/03.md`](../03.md) intact: the coordinator remains content-opaque and gains no new per-user mutable state.

### 2. Coordinator Involvement

None.

- The coordinator does not store, address, or validate session documents or tips.
- A session document never travels inside a group payload. It is exchanged out-of-band between devices of one identity.
- The coordinator's role is unchanged from [`spec/00.md`](../00.md) and [`spec/03.md`](../03.md): ordered, opaque, per-group delivery.

### 3. Device Model

`cordn` models a user's devices as replicas of one MLS client per group, not as separate MLS leaves.

- All devices of a user present the same MLS BasicCredential identity defined in [`spec/00.md`](../00.md) §6.
- All devices share a single leaf per group: the same `ClientState`, the same ratchet-tree position, and the same per-epoch secrets.
- Because devices share one leaf, the `application_id` LeafNode extension of RFC 9420 is not used to disambiguate devices. A group containing the user contains exactly one leaf for that user regardless of how many devices they operate.

This model trades per-device post-compromise security and per-device revocation for simpler UX, a smaller ratchet tree, and concealment of the user's device count from other group members. See §13.

### 4. Session Document

The session document is a JSON object. Its purpose is to seed groups on devices that lack them, advertise the set of groups the identity belongs to, and converge group state — including group removal — across devices (§8). It is not a log of messages and does not carry identity private keys.

```json
{
  "schemaVersion": 1,
  "issuedAt": 0,
  "prev": "<hex sha256 of previous document>",
  "groups": [
    {
      "gid": "<delivery group id, per spec/03 §2>",
      "coordinator": "<coordinator identity or key>",
      "metadata": { },
      "encrypted": true,
      "clientState": "<base64 of serialized MLS ClientState>",
      "cursor": 0
    }
  ],
  "removed": [
    { "gid": "<delivery group id>", "epoch": 7 }
  ]
}
```

Field requirements:

- `schemaVersion` MUST be `1`. Clients MUST reject documents with an unknown schema version.
- `issuedAt` is wall-clock milliseconds and is advisory; it is not a security primitive.
- `prev` SHOULD be populated with the address of the previous document (`sha256` of its sealed blob). Whenever a device has published a previous document it SHOULD set `prev` to that document's address: omitting it after a prior publish breaks the catch-up chain for that gap. `prev` forms a hash chain walkable on the immutable content store (§12) and is the mechanism that makes offline catch-up lossless (§8.5); its authenticity is transitive via the owner-endorsed tip (§6), so no per-document signature is needed (§8.5, §13).
- `groups[].gid` is the delivery group identifier ([`spec/03.md`](../03.md) §2), opaque to the coordinator and distinct from the MLS `group_id`.
- `groups[].coordinator` is the coordinator identity or public key that serves `gid`, so a seeded device knows where to fetch the delivery stream.
- `groups[].metadata` is OPTIONAL and carries the group's `CordnGroupMetadata` ([`spec/01.md`](../01.md)) for presentation only; authoritative metadata is what the receiver derives by replaying the stream.
- `groups[].encrypted` records whether the group uses end-to-end encrypted payloads ([`spec/03.md`](../03.md)); the seeded device adopts it as the group's outbound encryption mode.
- `groups[].clientState` is the base64 encoding of the serialized MLS `ClientState` for that group at the instant the document was written.
- `groups[].cursor` is the writer's last-processed delivery cursor for that `gid` at the same instant. The `(clientState, cursor)` pair MUST be a consistent snapshot: ingesting the delivery stream up to and including `cursor` MUST leave the writer at the epoch encoded in `clientState`.
- `removed` is OPTIONAL. Each entry is a tombstone `{gid, epoch}`, recording that the identity stopped tracking `gid` when the group was at MLS `epoch`. A `gid` appears in `groups` XOR `removed`, never both in the same document. `epoch` is the ordering primitive for the §8 resolution rule (not a timestamp); rejoin at a higher epoch clears a tombstone. Absence from both arrays means only that the publisher does not know the group (§8).

The document MUST NOT carry the identity's Nostr private key (`nsec`), key packages, pending welcomes, join requests, or messages. Devices are responsible for provisioning their own access to the identity, typically via a remote signer. The document converges *group state* only; it does not provision *identity*.

### 5. Canonical Encoding

The document plaintext is serialized as canonical JSON; this is the input to the seal (§7). The document **address** is `sha256` of the sealed (ciphertext) output, not of this plaintext (§6).

- UTF-8, object members in lexicographic code-point order by name, no insignificant whitespace.
- [RFC 8785](https://datatracker.ietf.org/doc/rfc8785/) is RECOMMENDED. Clients MAY serialize differently internally; only the sealed output is exchanged and addressed.

### 6. Content-Addressing and the Tip

The document address is `sha256` of the sealed blob (§7), lowercase hex. The address doubles as the content-addressed store key (e.g. the Blossom blob hash).

- The stored blob is the *sealed* document (§7). Its address is `sha256(blob)`.
- Clients MUST verify, after fetching, that `sha256(fetched bytes)` equals the advertised address. Mismatch MUST be rejected.
- The *tip* is the mutable pointer to the current document address. Devices read the tip to learn which address to fetch, and write the tip after publishing a new document.
- The tip transport is not normative, but a hardened Nostr replaceable event is RECOMMENDED (below). Any mechanism that resolves "current document address for this owner" is interoperable, because the tip is a lookup, not a protocol primitive; an out-of-band channel is an acceptable alternative.

**RECOMMENDED tip transport — an opaque replaceable event.** The owner's `npub` never appears in the clear on the network for this feature. The tip is a NIP-33 parameterized replaceable event signed by an **ephemeral keypair independent of the owner identity**. Its `content` is a NIP-44 seal (to the owner `npub`) of an *inner* Nostr event signed by the owner `npub` that points to the current document using standard Blossom blob-reference tags: `x` for the document `sha256` ([BUD-08](https://github.com/hzrd149/blossom/blob/master/buds/08.md)/NIP-94) and one or more ordered `server` tags for the Blossom server URLs hosting it ([BUD-03](https://github.com/hzrd149/blossom/blob/master/buds/03.md)). The outer ephemeral signature authorizes the replaceable event on the relay; the inner owner signature is the authenticity guarantee for the document.

```jsonc
// Outer event — relayed, replaceable, signed by the ephemeral key.
{
  "kind": 30078,            // application-specific; exact kind is a coordination detail (§14)
  "pubkey": "<ephemeral pubkey>",
  "content": "<NIP-44 v2 seal to owner npub of the inner event below>",
  "tags": [
    ["d", "<random opaque value, generated once>"]
  ],
  "created_at": 0,
  "sig": "<ephemeral key signature>"
}

// Inner event — sealed in the outer content; signed by the owner npub.
// `x` = document sha256 (the content address / tip value; BUD-08).
// `server` = ordered Blossom server URLs hosting the blob (BUD-03).
{
  "kind": 178,            // cordn application kind; coordination detail (§14). Sealed, never relayed, so its kind is self-labeling only.
  "pubkey": "<owner npub>",
  "content": "",
  "tags": [
    ["x", "<sha256 of the sealed session document>"],
    ["server", "https://blossom.example.tld"],
    ["server", "https://cdn.other.tld"]
  ],
  "created_at": 1700000000,
  "id": "<event id>",
  "sig": "<owner npub signature>"
}
```

- The `d` tag is random and **stable across republishes** (with the ephemeral pubkey it is the replaceable dedup key). Generated once and reused, it avoids cross-user fingerprinting; a per-publish value would break replaceability and accumulate events.
- The ephemeral signing key MUST be independent of the owner `nsec`. Deriving it is an anti-pattern: a public derivation scheme would let anyone compute the signing pubkey from the owner `npub` and query for the tip, defeating the unlinkability that motivates the design.
- The `content` is NIP-44-encrypted to the owner `npub`, so the event leaks nothing public beyond "some ephemeral account updates an opaque, randomly-tagged event" — no link to the owner, no link to `cordn`. The owner `npub` lives only inside the seal (as the inner event's signer), visible to no relay observer.
- Relays resolve the outer event by `(ephemeral pubkey, d)` and serve the greatest `created_at`. A device reads the tip, NIP-44-decrypts its `content` with the owner `nsec` to obtain the inner event, and verifies the inner event's owner signature. It then reads the `x` tag (document `sha256`) and the ordered `server` tags, and fetches `GET <server>/<x>` ([BUD-01](https://github.com/hzrd149/blossom/blob/master/buds/01.md)) trying servers in listed order (most reliable first), verifying `sha256(fetched blob) == x` (the §6 content-addressing check). `created_at` is author-set; a far-future value cannot corrupt state (the inner signature is owner-bound and documents are epoch-checked), only deny service transiently.
- The ephemeral `nsec` is a bounded-tier secret: leaking it can move the tip (republish under the ephemeral key) but cannot forge an acceptable inner pointer — that requires the owner `nsec`. Its only play is to repoint to a stale-but-valid older inner event — denial-of-service, not corruption (§13).
- Fetch locations come only from the sealed `server` tags, never from the owner's public `kind:10063` server list ([BUD-03](https://github.com/hzrd149/blossom/blob/master/buds/03.md)): that list is published under the owner `npub` and would defeat the tip's unlinkability.

**Connection string.** The tip's locator (a NIP-19 `naddr`: kind + ephemeral pubkey + `d` + relay hints) and write capability (the ephemeral `nsec`) travel together as a connection string minted by an existing device. See §11 for the bootstrap flow and rotation.

### 7. Document Sealing

The session document is sealed to the owner's own Nostr public key using [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) v2 encryption.

```
# The seal is confidentiality-only; the document carries no signature.
sealed  = nip44_v2.encrypt(ECDH(owner_nsec, owner_npub),
                           canonical_json(SessionDoc))
blob    = utf8(sealed)
address = sha256(blob)
```

Requirements:

- The document MUST be encrypted to the owner's own `npub`. Any device holding the `nsec`, or fronted by a signer able to perform the ECDH, can decrypt. No pairing, pre-shared key, passphrase, or additional KDF is defined.
- The sender and recipient public keys are equal; the NIP-44 payload's encrypted sender field therefore reveals only that the owner addressed itself.
- The MLS exporter is intentionally not used. The session document spans all of a user's groups and is not a payload of any single group; there is no single epoch secret to derive from. Reusing NIP-44 keeps content protection tied to the identity the user already manages.

The seal provides **confidentiality only**: NIP-44 to self does not authenticate the sender, since anyone can encrypt to the owner `npub`. Authenticity is provided by the **tip** (§6), not the document; the document therefore carries no signature and no owner `npub` (the owner `npub` appears only inside the tip's seal). Replay and rollback protection is provided by §8, not the seal. The distinct guarantees — NIP-44 seal = confidentiality, tip = authenticity, MLS `ClientState` = coherence, §8 = anti-downgrade — are summarized in §13.

### 8. Reconciliation

A device reconciles an incoming document against its local state.

**Resolution rule.** For each `gid`, the local state and the document each assert at most one fact: *present@E* (a `ClientState`, in local state or in `groups`) or *removed@E* (a tombstone, in `removed`). The device adopts the fact with the highest epoch; if a present fact and a removed fact share the highest epoch, removal wins. This single rule subsumes seeding, fast-forward, and removal:

- *Present vs. unknown* → seed the group (§9).
- *Present@E_doc vs. present@E_local* → if `E_doc > E_local`, advance (preferred: chained catch-up §8.5; fallback: single-snapshot fast-forward, adopting `clientState` and advancing the cursor to `max(local, entry.cursor)`); if `E_doc ≤ E_local`, the entry is advisory and MUST be ignored. Advancing is how sibling Commits propagate (§10): the serialized `clientState` carries the new leaf private keys the stream cannot convey.
- *Removed@E vs. present@E_local* → if `E ≥ E_local`, drop the local group; if `E < E_local`, the tombstone is stale and MUST be ignored.

A `gid` absent from both `groups` and `removed` is simply unknown to the publisher; the device MUST NOT treat absence as removal.

The forward-only epoch check is the rollback defense and is load-bearing. The document is authoritative for group existence, for seeding missing groups, for fast-forwarding to a strictly newer epoch, and for tombstoning at a newer-or-equal epoch; it is never authoritative for downgrading state. In particular:

- The cases above are equivalently prohibitions: never adopt a `clientState` at or below the local epoch, never apply a tombstone below the local epoch — so a replayed, rolled-back, or stale tip can at most deny service, never corrupt or delete newer state.
- The device MUST NOT advance an existing group's local delivery cursor past what the adopted `clientState` warrants. Fast-forward advances the cursor to the entry's `cursor` because the adopted state has processed through that point.

After reconciling, a device that holds newer local state — groups the document lacks or higher local epochs — SHOULD re-publish per the Operational Model (§10.5).

### 8.5 Chained Catch-Up (Offline History Recovery)

A single-snapshot fast-forward recovers liveness but loses application messages sent in the skipped epochs: by MLS forward secrecy, a `ClientState` at epoch N carries only epoch N's secret tree, so it cannot decrypt messages from epochs < N. The `prev` chain (§4) removes that loss for the epochs it covers.

A device whose local epoch is behind the tip SHOULD recover the gap losslessly before falling back to a single-snapshot fast-forward:

1. Walk `prev` from the tip back to the first document whose entry epoch is less than or equal to the local epoch. Collect one `ClientState` per strictly-newer epoch, keeping the OLDEST document for each epoch (smallest cursor = published right after that epoch's Commit, ratchet at generation 0). A newer same-epoch document has an advanced ratchet and cannot, by forward secrecy, derive earlier generations.
2. Fetch the message gap (every delivery-stream message after the local cursor).
3. Partition the gap by the chain's cursors into per-epoch ranges and decrypt each range with its epoch's `ClientState`. Third-party Commits inside a range are replayed in-band (they advance the state themselves); sibling Commits are skipped by the §10 guard and bridged by the next chain step's `ClientState`.

The device recovers every application message in every epoch the chain covers. Authenticity is transitive: the tip transport endorses the tip address (§6), each document commits to the next-older address via `prev`, and `sha256(blob) == address` is re-checked at every hop — so a blob the owner did not author cannot be reached through the chain.

The single-snapshot fast-forward (§8) remains the FALLBACK for when the chain is unavailable, incomplete, or deeper than the device is willing to walk: it recovers liveness (current group state) at the cost of the uncovered epochs' messages. The irreducible floor is an epoch with no document in the chain AND no replayable Commit — a publish that failed mid-chain, or a freshly-seeded device whose epoch predates the chain root (§9). In the common case (no Commit advanced the epoch while the device was offline) the device does not fast-forward at all and loses nothing.

### 9. Group Seeding

Seeding installs a group on a device without the Welcome flow defined in [`welcome-delivery.md`](welcome-delivery.md), because the device is adopting the shared leaf rather than joining as a new member.

To seed an entry:

1. Deserialize `clientState` into a local `ClientState`.
2. Record `gid`, `coordinator`, `metadata`, and `encrypted` as the group's local presentation and routing data.
3. Set the local delivery cursor for `gid` to the entry's `cursor`.
4. Begin normal fetch progression from `afterCursor = cursor` as defined in [`spec/00.md`](../00.md) §5 and [`spec/03.md`](../03.md).

The `cursor` is the writer's fetch progression, not the membership boundary (that role belongs to the Welcome `after` hint in [`welcome-delivery.md`](welcome-delivery.md) §2). The seeded device inherits the writer's current group state through `clientState` and receives messages posted after `cursor`; messages at or before `cursor` are not re-fetched. This is the intended state-sync trade: a freshly-seeded device converges on group state immediately and on message content from `cursor` forward, without the document carrying message history.

After seeding, the device catches up by ingesting the delivery stream. Application messages and Commits authored by OTHER members are processed normally. A Commit authored by a sibling device (same leaf) cannot be ingested from the stream (§10); the seeded device relies on chained catch-up (§8.5) for those, falling back to single-snapshot fast-forward (§8) when the chain is unavailable.

### 10. Convergence and Sibling Commits

The coordinator delivery stream and the session document each carry part of the truth. Convergence splits along who authored a Commit:

- **Application messages** converge via the delivery stream. Any device sharing the leaf can decrypt and process them, because they are sealed under the shared epoch key and the leaf's private keys are identical across devices.
- **Commits authored by other members** converge via the delivery stream. Every device is an ordinary member relative to another member's leaf and processes those Commits normally.
- **A Commit authored by a sibling device (the same shared leaf) does NOT converge via the delivery stream.** A Commit refreshes the committer's leaf with new HPKE keys via an UpdatePath; only the committer receives the corresponding private keys (from `createCommit`). A sibling device that tried to ingest the Commit would update its leaf's public keys to the committer's new keys without holding the private keys, which MLS surfaces as the member being removed from the group. Therefore:
  - A device MUST NOT ingest a Commit whose sender leaf index equals its own. Such a Commit is a sibling Commit; the device MUST skip it on the stream (advance the cursor, do not process, do not mark itself removed) and await convergence through the document. The detection is exact, not heuristic: in the shared-leaf model a sibling occupies the device's own leaf index, which no third party ever does. The sender leaf index is available to the client even when ingestion subsequently fails, because the MLS authorization callback is invoked before the Commit's UpdatePath is applied.
  - The committing device MUST re-publish the document after any epoch-advancing operation, and after creating a tombstone, so its siblings converge (§8). A client SHOULD expose this as a single hook fired when a locally-authored Commit is confirmed via self-echo, on group creation, and on soft-deleting a group, wired to re-publish via the Operational Model (§10.5). The hook is fire-and-forget: publishing latency MUST NOT block delivery.
  - Receiving devices converge by replaying the per-epoch `clientState` chain (§8.5), which carries the new leaf private keys; a single-snapshot fast-forward (§8) is the fallback when the chain is unavailable.

This split is the defining operational property of the shared-leaf model. It is why the document must carry full `clientState` (not just cursors) and why the committing device bears the burden of re-publishing after membership or metadata changes. Application traffic — the common case — needs no re-publish.

A soft-deleted group (§8 tombstone) is still a live MLS membership, so a sibling that advances it — any Commit, e.g. a metadata change — raises its epoch past the tombstone and the §8 resolution rule resurrects the group on every device. This is intended: a tombstone stops devices *tracking* a group, not *being in* it. Permanent removal is an MLS Leave (§11), a separate operation.

Concurrent Commits across devices of the same identity fall into two cases:

- **Asymmetric (one device commits while its siblings are quiescent):** converges automatically. The siblings skip the Commit on the stream and fast-forward once the committing device re-publishes. This is the normal case.
- **Symmetric (two devices commit within the same delivery round-trip window, before either sees the other's Commit):** a race. Each device confirms its OWN Commit via self-echo and skips the sibling's, so both advance to epoch N+1 with different states. The forward-only epoch check (§8) cannot pick a winner because the epoch numbers are equal, so neither document fast-forwards the other. This is a known limitation of the shared-leaf model without a tiebreaker. Mitigations, in order of preference:
  1. Re-publish promptly so siblings fast-forward before staging their own Commit. A client SHOULD refuse to stage a Commit on a group that has skipped a sibling Commit but not yet fast-forwarded (the device is known to be behind the canonical state).
  2. Surface a conflict signal so the user can re-sync the diverged device from the canonical device's document.
  3. Full automatic resolution (cursor tiebreaker plus state rollback) is possible but unspecified; it is disproportionate to a two-devices-admin-in-a-sub-second-window race.

Application traffic and single-admin scenarios — the overwhelming majority — are unaffected by the race.

### 10.5 Operational Model (Publish Discipline)

§8 governs reconciling an *incoming* document; this section governs publishing an *outgoing* one. A device's working state is its reconciled document view — the groups and tombstones it has adopted (§8) — plus its own unpublished changes. The discipline is what makes the convergence properties in §8 and §10 hold in practice: a device never overwrites a peer's newer state, and a deletion sticks across the fleet.

**Procedure (MUST).** Before publishing, a device fetches the current tip, reconciles it against local state (adopting newer facts — including tombstones — per §8), merges its local changes, then publishes and updates the tip. A device MUST NOT push without first ensuring it is current with the tip. Pushing blind is the root cause of two errors: clobbering a peer's newer state (re-adding a group a peer tombstoned, or tombstoning a group a peer advanced), and the stale-push resurrection race (§13). Last-tip-wins on `created_at` is acceptable because every publish reconciles first and carries the union of known facts; per-`gid` epoch comparison makes concurrent publication converge.

**Tip-address check (SHOULD).** Persist the last-seen document address. Before pushing, fetch only the tip event and compare its `x` (§6): if unchanged, no peer has published since and the device may push directly; if changed, reconcile first. This makes the discipline cheap in the common case of a single active writer.

**Offline (MUST).** If the tip cannot be fetched, the push MUST be deferred until the device is online and can reconcile. Queue the change; never push blind.

**Triggers.** A device re-publishes after any epoch-advancing Commit (so siblings converge, §10), after group creation, after creating a tombstone (soft-delete), and on startup if local state is ahead of the tip. Every trigger uses the procedure above.

**Tombstones ride the union.** The published `removed` array is the union of the device's own tombstones and any it adopted from peers. Carrying adopted tombstones forward is what propagates a deletion across the fleet — dropping one after adopting it would let a stale peer resurrect the group on the next publish.

**Non-blocking.** Publishing is fire-and-forget: its latency MUST NOT block message delivery (§10).

### 11. Device Addition and Removal

Adding a device is an identity-provisioning step, not an MLS operation. The new device obtains access to the owner's `nsec` (directly or via a signer) and is given a **connection string** (§6) by an existing device. From the string alone it bootstraps: it performs the tip read defined in §6 (parse the `naddr`, fetch the replaceable event, decrypt and verify, fetch and verify the blob) to obtain the document, then seeds every group (§9). It persists the ephemeral `nsec` so it can publish its own tip moves. No Welcomes are issued and group membership does not change, because the device adopts the existing shared leaf of each group.

The connection string is a one-shot, offline-shareable capability (locator + write key) — pairing reduced to a scannable code, not a mutual key-agreement ceremony. It carries no owner key material, but should be conveyed over a secure channel; its leak enables tip denial-of-service only (§6, §13).

**Rotation.** If a connection string leaks, the owner rotates by minting a fresh ephemeral keypair AND a fresh `d` together — rotating only the key leaves stale events under the old `(pubkey, d)` that readers must filter — publishing a new tip, and re-sharing a new connection string to every device. Devices still on the old string observe that the tip no longer advances while their local epochs move forward, and re-bootstrap from a fresh string.

Removing a device means revoking its access to the `nsec`. MLS cannot distinguish devices of one shared leaf, so per-device removal from a group is not possible: removing the user from a group removes the shared leaf and affects all devices. A device that retains `nsec` access after being "removed" in the application layer can continue to read the group until the group itself removes the leaf. This is an accepted property of the shared-leaf model (§13).

### 12. Content Store

Sealed documents are stored on a content-addressed store addressed by `sha256(blob)`.

- Upload, authentication, deletion, and retrieval are governed by the chosen store. For Blossom, the request-authentication event ([BUD-01](https://github.com/hzrd149/blossom/blob/master/buds/01.md)) MUST be signed by an ephemeral key, never the owner `npub`, consistent with the tip (§6). The same stable ephemeral keypair MAY be reused for tip and store auth; its leak is denial-of-service only (§13).
- [Blossom](https://github.com/hzrd149/blossom) is RECOMMENDED, consistent with [`encrypted-media.md`](encrypted-media.md). Any store that serves a blob by its hash is interoperable.
- A session document is a single, small JSON object. Chunking, deduplication, and merkle indexing (e.g. hashtree-style transports) are not used; they solve scaling problems this document does not have.

### 13. Security Considerations

Protected:

- **Confidentiality.** Only a device able to perform the owner ECDH can decrypt. The store and network observers see only sealed ciphertext.
- **Authenticity.** The document address a device fetches is endorsed by the tip's sealed, owner-signed inner event (§6); content-addressing (§6) carries that endorsement to the exact blob, so a blob the owner did not endorse cannot be reached through the tip. A leaked ephemeral write key cannot forge an acceptable pointer — that requires the owner `nsec` — so it can at most repoint to a stale-but-valid older pointer (denial-of-service). MLS `ClientState` validity is a second, per-state coherence gate.
- **Integrity and rollback defense.** Content-addressing plus the §8 forward-only epoch rule mean a replayed or rolled-back tip cannot downgrade an existing group's `ClientState`, advance its cursor past the adopted state, or apply a tombstone whose epoch is below the local epoch. Forging an acceptable *new* pointer requires the owner `nsec` (see Authenticity); a leaked ephemeral write key can only repoint to stale or undecryptable blobs — denial-of-service, not corruption.
- **History and catch-up.** The `prev` chain (§4) is a walkable, tamper-evident, owner-authenticated log on the immutable content store, and is the lossless offline-catch-up mechanism (§8.5); its transitive authenticity is described there. Catch-up holds each walked epoch's `ClientState` only for the duration of that epoch's replay and discards it, so past-epoch keys are not retained beyond the catch-up window.
- **Convergence.** Because the delivery stream is authoritative for application messages and third-party Commits, and the document converges sibling Commits under a forward-only epoch check (§8), conflicting documents cannot corrupt local MLS state.

Not protected (inherent to the shared-leaf model):

- **Soft-delete is not MLS removal.** A tombstone (§8) stops devices *tracking* a group; it does not end MLS membership. The identity remains a member, the coordinator may still deliver the group's messages (they are simply not fetched), and a sibling's Commit raises the epoch and resurrects the group (§10). Ending membership on every device requires an MLS Leave (§11).
- **No per-device post-compromise security.** Compromising one device compromises the shared leaf for every group until the user rekeys each group. An MLS Update/Commit from any device rekeys the leaf for all devices.
- **No per-device revocation.** Removing a user from a group removes all devices. See §11.
- **Device-count leakage.** The ratchet tree reveals one leaf per user regardless of device count. The content store and tip transport can still infer, from fetch and publish patterns, that more than one device is active.
- **Blob size and access patterns.** Document size approximates the number and size of the user's group states; the store can observe which devices fetch which tip and when.
- **Tip unlinkability is bounded.** The opaque tip (§6) defeats naive relay-side linking to the owner, but does not hide activity from an adversary that holds the connection string, nor from a global network observer. The content-store fetch necessarily exposes the blob address to the store; ephemeral store auth (§12) prevents linking the fetch to the owner `npub` but cannot hide that *some* device fetched *that* address.
- **Sibling-Commit ingestion hazard.** A client that fails to skip its own identity's Commits on the stream will mark itself removed from the group (§10). This is a correctness requirement, not a defense-in-depth measure.
- **`nsec` is load-bearing.** Sealing is to the owner `npub`. Anyone with the `nsec` decrypts every session document and, independently, can impersonate the leaf. This is the same trust root the rest of `cordn` already assumes; multi-device does not add a new one.

### 14. Interoperability Requirements

Implementations MUST agree on all of the following:

- the session document JSON shape and field semantics in §4
- NIP-44 v2 encryption to the owner's own `npub` as the seal (§7)
- content addressing by `sha256(blob)` where `blob` is the sealed document (§6)
- the reconciliation rule in §8: per `gid`, the highest-epoch fact wins — seed missing groups, fast-forward present groups only to a strictly newer epoch, apply tombstones only at ≥ the local epoch, never downgrade
- the `removed` tombstone shape `{gid, epoch}` (§4); absence from both `groups` and `removed` is not removal
- the group-seeding procedure and the use of `cursor` as the starting `afterCursor` (§9)
- the §10 rule that a device MUST NOT ingest a Commit whose sender leaf index equals its own (sibling-skip), and that the committing device MUST re-publish after any epoch-advancing operation
- the tip content format (§6): a NIP-44 seal of an owner-signed inner Nostr event whose `x` tag is the document `sha256` and whose `server` tags list the Blossom hosts ([BUD-08](https://github.com/hzrd149/blossom/blob/master/buds/08.md), [BUD-03](https://github.com/hzrd149/blossom/blob/master/buds/03.md))
- when using the RECOMMENDED tip transport (§6), the replaceable-event `kind` (a coordination detail all clients must agree on); the `d` value, ephemeral pubkey, and relay set are per-identity and travel in the connection string

Implementations MAY choose any tip transport that resolves a current document address for an owner (§6). Tip transport choice does not affect interoperability of the document itself.

### 15. Rationale

The model is intentionally minimal and reuses existing `cordn` primitives.

- **Shared leaf over per-device leaves.** Per-device leaves (RFC 9420 §5.2) provide per-device post-compromise security and revocation but require a Welcome per device per group, grow the ratchet tree with device count, and reveal device count to other members. The shared-leaf model accepts the security trade for simpler UX, a smaller tree, and concealed device count.
- **Seed-and-fast-forward, not merge.** MLS `ClientState` has linear history and cannot be merged. Missing groups are seeded; present groups fast-forward to a strictly newer epoch; equal-or-older documents are advisory. The forward-only epoch check makes the design rollback-safe without ever fusing two live states.
- **Tombstones for removal, not absence.** A group missing from the document is ambiguous (deleted vs. not-yet-known), and the §8 union-republish would flap it back. An explicit `removed` tombstone `{gid, epoch}` disambiguates and propagates deletion the way `groups` propagates presence. Epoch — not cursor, not wall-clock — is the ordering primitive: it advances only on a deliberate Commit, so a tombstone is overridden only by genuine re-engagement (rejoin, or a sibling Commit), never by passive message flow; and it is the forward-only guard that keeps a replayed old tombstone from deleting newer state. Soft-delete is layered above MLS — it stops devices tracking a group without ending membership — leaving MLS Leave (§11) as the permanent-removal operation.
- **Document carries full `clientState`.** This is forced by the shared-leaf Commit semantics in §10: a sibling's Commit cannot be ingested from the stream, so the new leaf private keys must travel in the document. Cursors alone would not suffice.
- **Blossom single blob.** A session document is small JSON; content-addressed single-blob storage is the simplest mechanism that satisfies the addressing and immutability requirements, and it is already used by [`encrypted-media.md`](encrypted-media.md).
- **Hardened, opaque tip transport.** The tip is a lookup, so any transport interoperates; a hardened Nostr replaceable event is RECOMMENDED because it keeps the coordinator content-opaque AND hides the owner's `cordn` usage and identity from passive relay observers. The ephemeral signer is independent (not derived) so knowledge of the owner `npub` cannot reveal the tip.
- **Seal to self; authenticity via the tip, not the document.** The user already manages an `nsec`, often via a remote signer. Reusing NIP-44 to the owner `npub` for the seal adds no new key, no pairing step, and no new trust root — but provides confidentiality only. Authenticity is moved into the tip as an owner-signed inner event sealed inside the outer ephemeral event: it reuses the same owner `nsec` (no new key), and because it lives inside the NIP-44 seal it never exposes the owner `npub` on the wire. This keeps the document a pure data blob and concentrates all signing in the tip.
- **Connection string over pairing ceremony.** Bootstrapping a device must convey *something* (a locator and write capability). A scannable `naddr` + ephemeral `nsec` string is the minimal such conveyance — offline, one-shot, no handshake — avoiding the mutual key-agreement UX the model otherwise rejects.
- **`prev` as history and catch-up.** Full-snapshot documents converge via the newer-epoch rule; the chain additionally lets a stale device recover the messages a single fast-forward would lose (§8.5), by replaying one `ClientState` per skipped epoch. The chain earns its place both as an immutable, authenticated log on the content store and as the offline-catch-up engine.
