# Cordn Multi-Device Synchronization

- Status: Draft

## Abstract

This document defines how `cordn` clients keep multiple devices of one identity synchronized without server-side key material or coordinator changes. Devices of a single user share one MLS leaf (one `ClientState` per group). They converge on application messages and third-party Commits by replaying the same opaque delivery stream defined in [`spec/03.md`](../03.md), and converge on sibling-device Commits by replaying a per-group chain of `ClientState` snapshots carried in sealed _group documents_ linked by `prev` — because a sibling's Commit cannot be ingested from the stream. State is split across two sealed, content-addressed document types: one _group document_ per live group (carrying that group's `ClientState` and cursor), and one _meta document_ per identity (carrying the account's last-resort key package and the set of soft-delete tombstones). Each document is addressed by `sha256` of its sealed blob and is advertised through a mutable, opaque _tip_ whose single sealed inner event lists every live group document plus the meta document, hiding the owner's identity and `cordn` usage from passive observers. The coordinator is unchanged: it continues to treat group messages as opaque bytes, as required by [`spec/03.md`](../03.md).

On-device MLS state storage is out of scope; alternative tip transports remain interoperable because the tip is a lookup.

## Specification

### 1. Overview

Multi-device reuses the delivery model of [`spec/03.md`](../03.md) for a separate concern: converging per-group client state across devices of one identity.

- A user's devices share a single MLS leaf per group: one `ClientState`, one membership, one set of per-epoch secrets.
- Application messages and Commits authored by other members converge via the per-group ordered delivery stream. A Commit authored by a sibling device (same leaf) does NOT: the committing device re-publishes that group's document, and siblings fast-forward their `ClientState` to the newer epoch from it.
- State is carried in two sealed, content-addressed document types:
  - A **group document** snapshots one group's MLS state and delivery cursor. It seeds a group a device lacks, advertises its coordinator, and converges group state (§10). Each group has its own `prev` chain of group documents for lossless offline catch-up (§8.5).
  - A **meta document** carries identity-level state shared across all groups: the account's last-resort key package (so any device can accept Welcomes, §11.5) and the set of soft-delete tombstones (so removals propagate and stick across the fleet, §8).
- Both document types are encrypted (sealed) with NIP-44 v2 to a per-identity document encryption key (DEK, §7) whose private key travels inside the tip's NIP-44 seal, stored on a content-addressed store chosen by the client, and addressed by `sha256` of the sealed blob. [Blossom](https://github.com/hzrd149/blossom) is RECOMMENDED.
- A mutable, opaque **tip** (§6) advertises the current document set: one `x`-tagged entry per live group document plus one for the meta document. Devices fetch the tip, verify the owner-signed pointer it carries, fetch only the documents whose addresses changed, decrypt, and reconcile (§8).

This keeps the trust boundary established by [`spec/03.md`](../03.md) intact: the coordinator remains content-opaque and gains no new per-user mutable state.

### 2. Coordinator Involvement

None.

- The coordinator does not store, address, or validate group documents, the meta document, or tips.
- A document never travels inside a group payload. Documents are exchanged out-of-band between devices of one identity.
- The coordinator's role is unchanged from [`spec/00.md`](../00.md) and [`spec/03.md`](../03.md): ordered, opaque, per-group delivery.

### 3. Device Model

`cordn` models a user's devices as replicas of one MLS client per group, not as separate MLS leaves.

- All devices of a user present the same MLS BasicCredential identity defined in [`spec/00.md`](../00.md) §6.
- All devices share a single leaf per group: the same `ClientState`, the same ratchet-tree position, and the same per-epoch secrets.
- Because devices share one leaf, the `application_id` LeafNode extension of RFC 9420 is not used to disambiguate devices. A group containing the user contains exactly one leaf for that user regardless of how many devices they operate.

This model trades per-device post-compromise security and per-device revocation for simpler UX, a smaller ratchet tree, and concealment of the user's device count from other group members. See §13.

### 4. Documents

There are two sealed JSON document types. Both reuse the same seal (§7) and addressing (§6). Their `type` field lets a client cross-check a fetched blob against its tip tag (§6).

#### 4.1 Group Document

One group document exists per live group, per epoch. It is the carrier of that group's presentation state and the unit of per-group republish.

```json
{
  "schemaVersion": 1,
  "type": "group",
  "issuedAt": 0,
  "prev": "<hex sha256 of the previous group document for this gid>",
  "gid": "<delivery group id, per spec/03 §2>",
  "coordinator": "<coordinator identity or key>",
  "clientState": "<base64 of serialized MLS ClientState>",
  "cursor": 0
}
```

Field requirements:

- `schemaVersion` MUST be `1`. Clients MUST reject documents with an unknown schema version.
- `type` MUST be `group`.
- `issuedAt` is wall-clock milliseconds and is advisory; it is not a security primitive.
- `prev` SHOULD be populated with the address (`sha256` of the sealed blob) of the previous group document for the same `gid`. Whenever a device has published a previous group document for a `gid` it SHOULD set `prev` to that document's address: omitting it after a prior publish breaks the catch-up chain for that gap. `prev` forms a per-`gid` hash chain walkable on the immutable content store (§12) and is the mechanism that makes offline catch-up lossless (§8.5); its authenticity is transitive via the owner-endorsed tip (§6), so no per-document signature is needed (§8.5, §13).
- `gid` is the delivery group identifier ([`spec/03.md`](../03.md) §2), opaque to the coordinator and distinct from the MLS `group_id`.
- `coordinator` is the coordinator identity or public key that serves `gid`, so a seeded device knows where to fetch the delivery stream.
- `clientState` is the base64 encoding of the serialized MLS `ClientState` for that group at the instant the document was written. It is the sole carrier of group presentation state: `CordnGroupMetadata` ([`spec/01.md`](../01.md)) is an MLS GroupContext extension and is therefore already inside `clientState`, so a seeded device reads it from the adopted state and the document does not duplicate it. Outbound payload encryption ([`spec/03.md`](../03.md)) is likewise absent: it is a local sender default each device configures itself, not a group property, and receivers handle both modes per message.
- `cursor` is the writer's last-processed delivery cursor for that `gid` at the same instant. The `(clientState, cursor)` pair MUST be a consistent snapshot: ingesting the delivery stream up to and including `cursor` MUST leave the writer at the epoch encoded in `clientState`.

A group document is published (and its `prev` chain extended) on group creation and on every epoch-advancing Commit in that group. It is removed from the tip when the group is soft-deleted (§8) or permanently left (§11).

#### 4.2 Meta Document

Exactly one meta document exists per identity. It carries identity-level state that is not specific to any one group: the account's last-resort key package and the set of soft-delete tombstones.

```json
{
  "schemaVersion": 1,
  "type": "meta",
  "issuedAt": 0,
  "removed": [{ "gid": "<delivery group id>", "epoch": 7 }],
  "lastResortKeyPackage": {
    "keyPackage": "<base64 of serialized MLS KeyPackage>",
    "privateKeyPackage": "<base64 of serialized MLS PrivateKeyPackage>"
  }
}
```

Field requirements:

- `schemaVersion` MUST be `1`. `type` MUST be `meta`.
- `issuedAt` is advisory wall-clock milliseconds; it is not a security primitive.
- The meta document has NO `prev` field. It is a current-state set, not a recovery log; its convergence is the union merge in §8 and its rollback defense is the per-`gid` epoch rule (§8), not a hash chain. Old meta blobs are superseded by the tip and reclaimable (§12).
- `removed` is OPTIONAL. Each entry is a tombstone `{gid, epoch}`, recording that the identity stopped tracking `gid` when the group was at MLS `epoch`. `epoch` is the ordering primitive for the §8 resolution rule (not a timestamp); rejoin at a higher epoch clears a tombstone.
- `lastResortKeyPackage` is OPTIONAL. It carries the account's currently-published last-resort key package (RFC 9420 §17.2) so any device can process a Welcome built against it (§11.5). `keyPackage` is the base64-encoded TLS wire form (RFC 9420 §3) of the MLS `KeyPackage`, and `privateKeyPackage` the matching TLS-encoded private key material — the init, leaf-encryption, and signature private keys, all needed at join time, which precedes any `clientState`. (TLS is the only MLS wire serialization; other blobs in this document, notably `clientState`, are library-serialized and intentionally not pinned to a wire format.) RFC 9420 caps a client at one last-resort key package and coordinators cap an account at one, so this is a single object, not an array. Absent when the account has published none; then Welcomes resolve only on the device that published the key package they reference (single-device behavior).

#### 4.3 Inventory Invariant

At any tip publish, a `gid` appears in exactly one of: a live group document (`x`-tagged `group` in the tip) XOR the meta document's `removed`. The publishing device enforces this: soft-deleting `gid` removes its group `x`-tag from the tip and adds `{gid, epoch}` to `removed`; a rejoin, or a sibling-Commit resurrection at a higher epoch, does the reverse. A `gid` absent from both is simply unknown to the publisher (§8). A receiving device that observes both (a malformed tip) resolves defensively by the §8 rule (highest epoch wins; ties to removal).

Neither document type carries the identity's Nostr private key (`nsec`), one-use key packages, pending welcomes, join requests, or messages. Devices are responsible for provisioning their own access to the identity, typically via a remote signer. The documents converge _group state_ and replicate the account's last-resort key package (§11.5); they do not provision _identity_.

### 5. Plaintext Encoding

Each document's plaintext is UTF-8 JSON; this is the input to the seal (§7). The document **address** is `sha256` of the sealed (ciphertext) output, not of this plaintext (§6). No canonical form is required: because NIP-44 (§7) uses a random salt, identical plaintext seals to different ciphertext and the address is over the ciphertext, so canonical JSON would enable neither addressing nor dedup — dedup is decided at the publish layer (§10.5).

### 6. Content-Addressing and the Tip

A document address is `sha256` of its sealed blob (§7), lowercase hex. The address doubles as the content-addressed store key (e.g. the Blossom blob hash).

- The stored blob is the _sealed_ document (§7). Its address is `sha256(blob)`.
- Clients MUST verify, after fetching, that `sha256(fetched bytes)` equals the advertised address. Mismatch MUST be rejected.
- The _tip_ is the mutable pointer to the current document set. Devices read the tip to learn which documents to fetch, and write the tip after publishing.
- The tip transport is not normative, but a hardened Nostr replaceable event is RECOMMENDED (below). Any mechanism that resolves "current document set for this owner" is interoperable, because the tip is a lookup, not a protocol primitive; an out-of-band channel is an acceptable alternative.

**RECOMMENDED tip transport — an opaque replaceable event.** The owner's `npub` never appears in the clear on the network for this feature. The tip is a NIP-33 parameterized replaceable event signed by an **ephemeral keypair independent of the owner identity**. Its `content` is a NIP-44 seal of an _inner_ Nostr event signed by the owner `npub` that lists the current document set using typed `x` tags: one `["x", <group-doc sha256>, "group", <gid>]` per live group and exactly one `["x", <meta-doc sha256>, "meta"]`, one `dek` tag carrying the per-identity DEK private key (§7), plus one or more ordered `server` tags for the Blossom server URLs hosting the blobs ([BUD-03](https://github.com/hzrd149/blossom/blob/master/buds/03.md)). The outer ephemeral signature authorizes the replaceable event on the relay; the inner owner signature is the authenticity guarantee for the documents. The seal's sender MUST be the owner `npub` (a self-seal: sender = recipient = owner). NIP-44's conversation key is ECDH(sender_priv, recipient_pub), so sealing from any other key would let any holder of that key's private half — including a connection-string leak (§11) — derive the seal and recover the DEK it carries (§7).

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
// One typed `x` per live group document, one `x` for the meta document.
// `dek` = the DEK private key (§7), 64 lowercase hex chars; pubkey derived locally.
// `server` = ordered Blossom server URLs hosting ALL listed blobs (BUD-03).
{
  "kind": 178,            // cordn application kind; coordination detail (§14). Sealed, never relayed.
  "pubkey": "<owner npub>",
  "content": "",
  "tags": [
    ["x", "<sha256 of sealed group document>", "group", "<gid>"],
    ["x", "<sha256 of sealed group document>", "group", "<gid>"],
    ["x", "<sha256 of sealed meta document>",  "meta"],
    ["dek", "<64 lowercase hex chars of the DEK private key, §7>"],
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
- The `content` is NIP-44-encrypted to the owner `npub`, so the event leaks nothing public beyond "some ephemeral account updates an opaque, randomly-tagged event" — no link to the owner, no link to `cordn`. The owner `npub` lives only inside the seal (as the inner event's signer), visible to no relay observer. The sealed inner event's size grows with the number of live groups (one typed `x` each); only its ciphertext length is observable (§13).
- The `group` tag's 4th element is the `gid`. A device persists the last-seen `x` value per `gid` (and for the `meta` tag) so that, after reading the tip, it can diff and fetch only the documents whose addresses changed — unchanged group documents are not re-fetched. This is the per-document generalization of the §10.5 tip-address check.
- Relays resolve the outer event by `(ephemeral pubkey, d)` and serve the greatest `created_at`. A device reads the tip, NIP-44-decrypts its `content` with the owner `nsec` to obtain the inner event, verifies the inner event's owner signature, and reads the `dek` tag (§7) plus each `x` tag. For each `x` tag it reads the hash, the type, and (for `group`) the `gid`; it fetches `GET <server>/<x>` ([BUD-01](https://github.com/hzrd149/blossom/blob/master/buds/01.md)) trying servers in listed order (most reliable first), verifying `sha256(fetched blob) == x` (the §6 content-addressing check), decrypting the blob with the DEK (§7), and checking that the decrypted `type` matches the tag. `created_at` is author-set; a far-future value cannot corrupt state (the inner signature is owner-bound and documents are epoch-checked), only deny service transiently.
- The ephemeral `nsec` is a bounded-tier secret: leaking it can move the tip (republish under the ephemeral key) but cannot forge an acceptable inner pointer — that requires the owner `nsec` — and cannot decrypt the seal, which is owner self-sealed (above). Its only play is to repoint to a stale-but-valid older inner event — denial-of-service, not corruption (§13).
- Fetch locations come only from the sealed `server` tags, never from the owner's public `kind:10063` server list ([BUD-03](https://github.com/hzrd149/blossom/blob/master/buds/03.md)): that list is published under the owner `npub` and would defeat the tip's unlinkability.

**Connection string.** The tip's locator (a NIP-19 `naddr`: kind + ephemeral pubkey + `d` + relay hints) and write capability (the ephemeral `nsec`) travel together as a connection string minted by an existing device. See §11 for the bootstrap flow and rotation.

### 7. Document Sealing

Each document is sealed to a per-identity **document encryption key (DEK)** using [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) v2 — the same seal `cordn` already uses, applied as a self-seal to the DEK's own pubkey. The DEK is a fresh Nostr keypair, independent of the owner identity and of the ephemeral signing key, generated once per identity and reused across every publish. Its private key (64 hex chars) travels inside the tip's sealed inner event (§6 `dek` tag); its pubkey is derived locally. Rotating the DEK is a deliberate operation that re-encrypts every live document; it is NOT rotated per publish.

```
# The seal is confidentiality-only; documents carry no signature.
# Identical to the owner self-seal — only the recipient key changes.
sealed  = nip44_v2.encrypt(dek_priv, dek_pub, json(GroupDoc | MetaDoc))
blob    = utf8(sealed)
address = sha256(blob)
```

Requirements:

- The DEK is a fresh Nostr keypair per identity. Devices obtain its private key only by reading the tip: the inner event is NIP-44-sealed to the owner `npub`, so the DEK is confidential to the owner, and the owner signature on the inner event makes it authentic — the same two properties the tip already provides for the document inventory. The DEK adds no new trust root and no new crypto beyond the NIP-44 v2 the user already manages.
- The DEK MUST be independent of the ephemeral signing key. The ephemeral `nsec` is a bounded-tier secret whose leak is denial-of-service only (§6, §13); coupling document confidentiality to it would expose every document — including the meta document's MLS private keys (§4.2) — to a connection-string leak. Keeping the DEK behind the owner-NIP-44 seal preserves that bounded-tier property.
- The seal is NIP-44 to self (sender and recipient are the same DEK keypair), so it provides confidentiality only — anyone holding the DEK can both encrypt and decrypt. Authenticity comes from the tip (§6), not the document; documents carry no signature and no owner `npub` (the owner `npub` and the DEK private key appear only inside the tip's seal).
- The MLS exporter is intentionally not used. The documents span all of a user's groups (meta) or carry state that must be decryptable before any group's epoch secrets exist (a group document seeding a brand-new group); there is no single group epoch secret to derive from.

The seal provides **confidentiality only**: the DEK is reachable only through the owner-NIP-44-sealed tip, so document confidentiality reduces to owner-`nsec` confidentiality. Authenticity is provided by the **tip** (§6), not the document; replay and rollback protection is provided by §8, not the seal. Legacy documents sealed directly to the owner `npub` (before the DEK existed) MAY still exist; clients decrypt them with the owner `nsec`, and a republish re-seals them to the DEK. The distinct guarantees — DEK seal = confidentiality, tip = authenticity, MLS `ClientState` = coherence, §8 = anti-downgrade — are summarized in §13.

### 8. Reconciliation

A device reconciles the tip's document set against its local state.

**Resolution rule.** Reconciliation is a state-based CRDT (CvRDT): a map of per-`gid` last-writer-wins registers ordered by epoch, plus the meta document's key-package field. The merge is associative, commutative, and idempotent. For each `gid`, the local state and the tip/meta each assert at most one fact: _present@E_ (a `ClientState`, in local state or in a fetched group document) or _removed@E_ (a tombstone, in the meta document's `removed`). The device adopts the fact with the highest epoch; if a present fact and a removed fact share the highest epoch, removal wins. This single rule subsumes seeding, fast-forward, rejoin, and removal:

- _Present (group doc) vs. unknown_ → seed the group (§9).
- _Present@E_doc vs. present@E_local_ → if `E_doc > E_local`, advance (preferred: chained catch-up §8.5; fallback: single-snapshot fast-forward, adopting `clientState` and advancing the cursor to `max(local, doc.cursor)`); if `E_doc ≤ E_local`, the document is advisory and MUST be ignored. Advancing is how sibling Commits propagate (§10): the serialized `clientState` carries the new leaf private keys the stream cannot convey.
- _Present@E_doc vs. removed@E_local_ → if `E_doc > E_local`, the group was rejoined or resurrected by a sibling Commit; clear the tombstone and adopt the present fact (seed/advance as above). If `E_doc ≤ E_local`, the live document is stale and the tombstone stands.
- _Removed@E_meta vs. present@E_local_ → if `E_meta ≥ E_local`, drop the local group; if `E_meta < E_local`, the tombstone is stale and MUST be ignored.
- _Removed@E_meta vs. removed@E_local_ → keep the higher-epoch tombstone.

A `gid` absent from both the tip's group list and the meta document's `removed` is simply unknown to the publisher; the device MUST NOT treat absence as removal.

**Reconcile invariant (MUST).** A `gid` that appears in the tip's group list MUST be resolved against its fetched group document, even if the device currently holds it as tombstoned — because a rejoin publishes a higher-epoch group document and only the §8 rule can clear the local tombstone. Skipping a live group document because the `gid` is locally tombstoned would leave a stale tombstone in place of a live group.

The `lastResortKeyPackage` field reconciles outside the per-`gid` rule: a device loads the meta document's entry, when present, into its local key-package store so the Welcome matcher can resolve a Welcome built against it (§11.5). It carries no epoch — at most one exists per account (§4.2) — so there is nothing to fast-forward or tombstone; the coordinator's one-per-account cap selects the canonical entry when two devices have published concurrently, and §10.5 reconcile-before-push makes the fleet converge on it.

The forward-only epoch check is the rollback defense and is load-bearing. The documents are authoritative for group existence, for seeding missing groups, for fast-forwarding to a strictly newer epoch, for clearing a tombstone on rejoin, and for tombstoning at a newer-or-equal epoch; they are never authoritative for downgrading state. In particular:

- The cases above are equivalently prohibitions: never adopt a `clientState` at or below the local epoch, never apply a tombstone below the local epoch — so a replayed, rolled-back, or stale tip can at most deny service, never corrupt or delete newer state.
- The device MUST NOT advance an existing group's local delivery cursor past what the adopted `clientState` warrants. Fast-forward advances the cursor to the document's `cursor` because the adopted state has processed through that point.

After reconciling, a device that holds newer local state — groups the tip lacks, or higher local epochs — SHOULD re-publish per the Operational Model (§10.5).

### 8.5 Chained Catch-Up (Offline History Recovery)

A single-snapshot fast-forward recovers liveness but loses application messages sent in the skipped epochs: by MLS forward secrecy, a `ClientState` at epoch N carries only epoch N's secret tree, so it cannot decrypt messages from epochs < N. The per-`gid` `prev` chain (§4.1) removes that loss for the epochs it covers, independently per group.

A device whose local epoch for a group is behind that group's tip document SHOULD recover the gap losslessly before falling back to a single-snapshot fast-forward:

1. Walk that group's `prev` chain from the tip's group document back to the first document whose epoch (read from its `clientState`) is less than or equal to the local epoch. Collect one `ClientState` per strictly-newer epoch, keeping the OLDEST document for each epoch (smallest cursor = published right after that epoch's Commit, ratchet at generation 0). A newer same-epoch document has an advanced ratchet and cannot, by forward secrecy, derive earlier generations.
2. Fetch that group's message gap (every delivery-stream message after the local cursor).
3. Partition the gap by the chain's cursors into per-epoch ranges and decrypt each range with its epoch's `ClientState`. Third-party Commits inside a range are replayed in-band (they advance the state themselves); sibling Commits are skipped by the §10 guard and bridged by the next chain step's `ClientState`.

The device recovers every application message in every epoch the chain covers, for that group, without fetching other groups' history. Authenticity is transitive: the tip transport endorses the tip group document (§6), each group document commits to the next-older document for the same `gid` via `prev`, and `sha256(blob) == address` is re-checked at every hop — so a blob the owner did not author cannot be reached through the chain.

The single-snapshot fast-forward (§8) remains the FALLBACK for when the chain is unavailable, incomplete, or deeper than the device is willing to walk: it recovers liveness (current group state) at the cost of the uncovered epochs' messages. The irreducible floor is an epoch with no document in the chain AND no replayable Commit — a publish that failed mid-chain, or a freshly-seeded device whose epoch predates the chain root (§9). In the common case (no Commit advanced the epoch while the device was offline) the device does not fast-forward at all and loses nothing.

### 9. Group Seeding

Seeding installs a group on a device without the Welcome flow defined in [`welcome-delivery.md`](welcome-delivery.md), because the device is adopting the shared leaf rather than joining as a new member.

To seed a group from its group document:

1. Deserialize `clientState` into a local `ClientState`.
2. Record `gid` and `coordinator` as the group's routing data, and derive its presentation metadata from the adopted state's `CordnGroupMetadata` GroupContext extension ([`spec/01.md`](../01.md)).
3. Set the local delivery cursor for `gid` to the document's `cursor`.
4. Begin normal fetch progression from `afterCursor = cursor` as defined in [`spec/00.md`](../00.md) §5 and [`spec/03.md`](../03.md).

The `cursor` is the writer's fetch progression, not the membership boundary (that role belongs to the Welcome `after` hint in [`welcome-delivery.md`](welcome-delivery.md) §2). The seeded device inherits the writer's current group state through `clientState` and receives messages posted after `cursor`; messages at or before `cursor` are not re-fetched. This is the intended state-sync trade: a freshly-seeded device converges on group state immediately and on message content from `cursor` forward, without the document carrying message history.

After seeding, the device catches up by ingesting the delivery stream. Application messages and Commits authored by OTHER members are processed normally. A Commit authored by a sibling device (same leaf) cannot be ingested from the stream (§10); the seeded device relies on chained catch-up (§8.5) for those, falling back to single-snapshot fast-forward (§8) when the chain is unavailable.

### 10. Convergence and Sibling Commits

The coordinator delivery stream and the documents each carry part of the truth. Convergence splits along who authored a Commit:

- **Application messages** converge via the delivery stream. Any device sharing the leaf can decrypt and process them, because they are sealed under the shared epoch key and the leaf's private keys are identical across devices.
- **Commits authored by other members** converge via the delivery stream. Every device is an ordinary member relative to another member's leaf and processes those Commits normally.
- **A Commit authored by a sibling device (the same shared leaf) does NOT converge via the delivery stream.** A Commit refreshes the committer's leaf with new HPKE keys via an UpdatePath; only the committer receives the corresponding private keys (from `createCommit`). A sibling device that tried to ingest the Commit would update its leaf's public keys to the committer's new keys without holding the private keys, which MLS surfaces as the member being removed from the group. Therefore:
  - A device MUST NOT ingest a Commit whose sender leaf index equals its own. Such a Commit is a sibling Commit; the device MUST skip it on the stream (advance the cursor, do not process, do not mark itself removed) and await convergence through the group document. The detection is exact, not heuristic: in the shared-leaf model a sibling occupies the device's own leaf index, which no third party ever does. The sender leaf index is available to the client even when ingestion subsequently fails, because the MLS authorization callback is invoked before the Commit's UpdatePath is applied.
  - The committing device MUST publish a new group document for that group after any epoch-advancing operation, so its siblings converge (§8). A client SHOULD expose this as a single hook fired when a locally-authored Commit is confirmed via self-echo, on group creation, and on soft-deleting a group, wired to re-publish via the Operational Model (§10.5). The hook is fire-and-forget: publishing latency MUST NOT block delivery.
  - Receiving devices converge by replaying that group's per-epoch `clientState` chain (§8.5), which carries the new leaf private keys; a single-snapshot fast-forward (§8) is the fallback when the chain is unavailable. A device must reconcile the tip before opening the delivery stream (§10.6).

This split is the defining operational property of the shared-leaf model. It is why a group document must carry full `clientState` (not just cursors) and why the committing device bears the burden of re-publishing after membership or metadata changes. Application traffic — the common case — needs no re-publish.

A soft-deleted group (§8 tombstone) is still a live MLS membership, so a sibling that advances it — any Commit, e.g. a metadata change — raises its epoch past the tombstone and the §8 resolution rule resurrects the group on every device (a new live group document at the higher epoch clears the tombstone). This is intended: a tombstone stops devices _tracking_ a group, not _being in_ it. Permanent removal is an MLS Leave (§11), a separate operation.

Concurrent Commits across devices of the same identity fall into two cases:

- **Asymmetric (one device commits while its siblings are quiescent):** converges automatically. The siblings skip the Commit on the stream and fast-forward once the committing device publishes the new group document. This is the normal case.
- **Symmetric (two devices commit within the same delivery round-trip window, before either sees the other's Commit):** a race within one group. Each device confirms its OWN Commit via self-echo and skips the sibling's, so both advance to epoch N+1 with different states. The forward-only epoch check (§8) cannot pick a winner because the epoch numbers are equal, so neither group document fast-forwards the other. This is a known limitation of the shared-leaf model without a tiebreaker. Mitigations, in order of preference:
  1. Re-publish promptly so siblings fast-forward before staging their own Commit. A client SHOULD refuse to stage a Commit on a group that has skipped a sibling Commit but not yet fast-forwarded (the device is known to be behind the canonical state).
  2. Surface a conflict signal so the user can re-sync the diverged device from the canonical device's group document.
  3. Full automatic resolution (cursor tiebreaker plus state rollback) is possible but unspecified; it is disproportionate to a two-devices-admin-in-a-sub-second-window race.

Concurrent Commits across _different_ groups are independent: each publishes its own group document and updates its own `x` tag in the tip, so neither clobbers the other at the document layer. They still serialize through the single replaceable tip event (§6); last-tip-wins on `created_at` may briefly omit one device's `x` update until the next publish self-heals (§10.5).

Application traffic and single-admin scenarios — the overwhelming majority — are unaffected by the race.

### 10.5 Operational Model (Publish Discipline)

§8 governs reconciling _incoming_ documents; this section governs publishing _outgoing_ ones. A device's working state is its reconciled view — the live groups, tombstones, and key package it has adopted (§8) — plus its own unpublished changes. The discipline is what makes the convergence properties in §8 and §10 hold in practice: a device never overwrites a peer's newer state, and a deletion sticks across the fleet.

**Publishing unit.** A device publishes per document type: a group change publishes only that group's document and updates only its `group` `x` tag in the tip; a tombstone or key-package change publishes only the meta document and updates only the `meta` `x` tag. Unchanged group documents are not re-sealed, re-uploaded, or re-fetched: dedup happens at the publish-decision layer, not the content layer.

**Procedure (MUST).** Before publishing, a device fetches the current tip, reconciles its full document set against local state (adopting newer facts — including tombstones — per §8), merges its local changes, then publishes the affected document(s) and rewrites the tip with the full current inventory (one `group` `x` per live group + one `meta` `x`). A device MUST NOT push without first ensuring it is current with the tip. Pushing blind is the root cause of two errors: clobbering a peer's newer state (re-adding a group a peer tombstoned, or tombstoning a group a peer advanced), and the stale-push resurrection race (§13). Last-tip-wins on `created_at` is acceptable because every publish reconciles first and the inventory is the union of known facts; per-`gid` epoch comparison makes concurrent publication converge.

**Tip-address check (SHOULD).** Persist the last-seen inner event (its `x` tags and the tip event id). Before pushing, fetch only the tip event: if its id is unchanged, no peer has published since and the device may push directly; if changed, reconcile first. This makes the discipline cheap in the common case of a single active writer.

**Offline (MUST).** If the tip cannot be fetched, the push MUST be deferred until the device is online and can reconcile. Queue the change; never push blind.

**Triggers.** A device re-publishes after any epoch-advancing Commit in a group (so siblings converge, §10), after group creation, after creating a tombstone (soft-delete), after publishing or rotating the account's last-resort key package (§11.5), and on startup if local state is ahead of the tip. Every trigger uses the procedure above.

**Tombstones live in the meta document.** The published `removed` set is the union of the device's own tombstones and any it adopted from peers, taken per-`gid` at the highest epoch. Because the meta document is reconciled (union-merged) before each publish and then republished as a single set, carrying adopted tombstones forward is automatic: a deletion persists across the fleet until a higher-epoch present fact (rejoin or sibling Commit) supersedes it. The meta document is the durable record of removals — discoverable through a single permanent tip slot, independent of which groups are currently live — so a tombstoned group cannot be resurrected by a peer merely because its live `x` tag was evicted from the tip.

**Non-blocking.** Publishing is fire-and-forget: its latency MUST NOT block message delivery (§10).

### 10.6 Ingest Discipline

§10.5 governs publishing; this section governs receiving. The delivery stream and the documents converge only if a device has adopted the canonical `ClientState` for a group before it tries to decrypt messages sealed under that state.

**Procedure (MUST).** On startup and on reconnect, a multi-device client fetches the current tip and reconciles it (§8) — fast-forwarding every group whose local epoch is below the tip group document's, via chained catch-up (§8.5) or single-snapshot fallback (§8) — _before_ opening the delivery stream for any group. A device MUST NOT begin backlog fetch for a group whose local epoch is behind the tip: the backlog will contain messages sealed under epochs it has not adopted, and those cannot be decrypted. (A freshly seeded group is already at the document's epoch by construction, §9.)

**Behind is not corruption.** Reconciling on startup closes the common gap, but a sibling may Commit and advance the epoch _while the device is connected_, before its re-published tip arrives (§10). The device then receives a message at an epoch above its adopted state. This is a _behind_ condition, not a fault: the device awaits the sibling's re-published tip, fast-forwards, and processes the message then. Only a message that remains undecryptable _at the device's current adopted epoch_ indicates corrupt local state. A client MUST NOT treat a higher-epoch undecryptable message as fatal.

### 11. Device Addition and Removal

Adding a device is an identity-provisioning step, not an MLS operation. The new device obtains access to the owner's `nsec` (directly or via a signer) and is given a **connection string** (§6) by an existing device. From the string alone it bootstraps: it performs the tip read defined in §6 (parse the `naddr`, fetch the replaceable event, decrypt and verify) to obtain the document inventory, then fetches each live group document and the meta document, seeds every group (§9), and — through the same reconcile (§8) — loads the account's last-resort key package (§11.5), so it can accept Welcomes from its first startup. It persists the ephemeral `nsec` so it can publish its own tip moves. No Welcomes are issued and group membership does not change, because the device adopts the existing shared leaf of each group.

The connection string is a one-shot, offline-shareable capability (locator + write key) — pairing reduced to a scannable code, not a mutual key-agreement ceremony. It carries no owner key material, but should be conveyed over a secure channel; its leak enables tip denial-of-service only (§6, §13).

**Rotation.** If a connection string leaks, the owner rotates by minting a fresh ephemeral keypair AND a fresh `d` together — rotating only the key leaves stale events under the old `(pubkey, d)` that readers must filter — publishing a new tip, and re-sharing a new connection string to every device. Devices still on the old string observe that the tip no longer advances while their local epochs move forward, and re-bootstrap from a fresh string.

Removing a device means revoking its access to the `nsec`. MLS cannot distinguish devices of one shared leaf, so per-device removal from a group is not possible: removing the user from a group removes the shared leaf and affects all devices. A device that retains `nsec` access after being "removed" in the application layer can continue to read the group until the group itself removes the leaf. This is an accepted property of the shared-leaf model (§13).

### 11.5 Last-Resort Key Package

A Welcome is HPKE-sealed to one specific key package's `init_key` and referenced by its hash; only the holder of the matching `PrivateKeyPackage` can decrypt the group secrets and join. In the shared-leaf model a sibling device cannot process a Welcome built against another device's key package — it sees "key package not available" — so if the publishing device is offline the Welcome stalls even though a sibling is online.

The meta document closes this for the account's durable key package. A last-resort key package (RFC 9420 §17.2) is reusable — it may appear in more than one Welcome without the one-use hygiene rule — and a multi-device identity normally has one published (or none); coordinators cap an account to one. The meta document carries that one entry (§4.2 `lastResortKeyPackage`); on reconcile (§8) every device loads it into its local key-package store, so the Welcome matcher — which resolves an incoming Welcome by `key_package_hash` — finds it on any device. Any device can then process a Welcome a third party builds against the account's last-resort key package.

**Why last-resort, and why one.** A reusable key package needs no consume-and-prune lifecycle (the one-use rule is hygiene, not crypto), which is why the field carries the last-resort package specifically rather than every key package the account has published; one-use key packages stay device-local. RFC 9420 caps a client at one last-resort key package and coordinators cap an account to one, so the field is a single optional object, never an array.

**Lifecycle.** When a device publishes or rotates the account's last-resort key package, it writes the entry into the meta document and re-publishes it (a trigger alongside those in §10.5). Reconcile adopts the meta document's entry; the coordinator's one-per-account cap selects the canonical entry when two devices have published concurrently, and §10.5's reconcile-before-push makes the fleet converge on it. Expired or superseded entries are dropped on the next publish.

**Scope.** This transports what the account already has; it does not mandate publishing a last-resort key package. An account with none published gets no cross-device Welcome coverage — Welcomes then resolve only on the device that published the key package they reference, which is the single-device behavior. Accounts that publish a last-resort key package (the normal case, since it makes adds robust even for a single device) gain cross-device coverage for free.

### 12. Content Store

Sealed documents are stored on a content-addressed store addressed by `sha256(blob)`.

- Upload, authentication, deletion, and retrieval are governed by the chosen store. For Blossom, the request-authentication event ([BUD-01](https://github.com/hzrd149/blossom/blob/master/buds/01.md)) MUST be signed by an ephemeral key, never the owner `npub`, consistent with the tip (§6). The same stable ephemeral keypair MAY be reused for tip and store auth; its leak is denial-of-service only (§13).
- [Blossom](https://github.com/hzrd149/blossom) is RECOMMENDED, consistent with [`encrypted-media.md`](encrypted-media.md). Any store that serves a blob by its hash is interoperable.
- Documents are small JSON objects, sharded by concern: one per live group (the unit of per-group republish and per-group catch-up) plus one meta document. Chunking below the document level, deduplication within a document, and merkle indexing (e.g. hashtree-style transports) are not used.

**Garbage collection.**
- *Group chains (per group).* Each group's `prev` chain is independent and MAY be bounded. A device or store hosting a group's chain SHOULD retain the most recent K epoch documents per group and MAY Blossom-delete older blobs; §8.5's single-snapshot fast-forward is the defined fallback for any epoch whose chain link is missing. Bounded chains trade lossless catch-up depth for bounded storage; the irreducible floor (§8.5) is unchanged.
- *Meta blobs.* The meta document has no chain — a superseded meta blob serves no catch-up or rollback purpose (it is a current-state set, §4.2) — so it SHOULD be Blossom-deleted once the tip has moved past it (a short grace window for in-flight fetches is RECOMMENDED). Deletion is event-driven on supersede, driven by the current tip plus the publisher's own upload record. The `removed` set inside the current meta is NOT trimmed: a tombstone must remain visible until a higher-epoch present fact supersedes it (§8), and without an acknowledgement protocol a device cannot know all peers have processed a removal, so tombstones are retained for the identity's lifetime — bounded by group churn, a few tens of bytes each.

### 13. Security Considerations

Protected:

- **Confidentiality.** Only a device that can read the tip's NIP-44 seal (i.e., a holder of the owner `nsec`) can obtain the DEK (§7), and only the DEK can decrypt documents. The store and network observers see only sealed ciphertext; a leaked ephemeral write key cannot decrypt documents, because the DEK lives behind the owner-NIP-44 seal, not behind the ephemeral key. Caching the DEK locally so document decrypts skip the signer is the design's purpose; a reconciled device already holds equivalent plaintext locally (its MLS `ClientState` and key-package store), so local DEK caching does not meaningfully expand what a device compromise exposes.
- **Authenticity.** Every document address a device fetches is endorsed by the tip's sealed, owner-signed inner event (§6); content-addressing (§6) carries that endorsement to the exact blob, so a blob the owner did not endorse cannot be reached through the tip. A leaked ephemeral write key cannot forge an acceptable pointer — that requires the owner `nsec` — so it can at most repoint to a stale-but-valid older pointer (denial-of-service). MLS `ClientState` validity is a second, per-state coherence gate.
- **Integrity and rollback defense.** Content-addressing plus the §8 forward-only epoch rule mean a replayed or rolled-back tip cannot downgrade an existing group's `ClientState`, advance its cursor past the adopted state, or apply a tombstone whose epoch is below the local epoch. Forging an acceptable _new_ pointer requires the owner `nsec` (see Authenticity); a leaked ephemeral write key can only repoint to stale or undecryptable blobs — denial-of-service, not corruption.
- **History and catch-up.** Each group's `prev` chain (§4.1) is a walkable, tamper-evident, owner-authenticated log on the immutable content store, and is the lossless offline-catch-up mechanism for that group (§8.5); its transitive authenticity is described there. Catch-up holds each walked epoch's `ClientState` only for the duration of that epoch's replay and discards it, so past-epoch keys are not retained beyond the catch-up window.
- **Convergence (CvRDT).** Reconciliation (§8) is a state-based CRDT — per-`gid` LWW registers ordered by epoch with explicit tombstones, merged associatively, commutatively, and idempotently. Because the delivery stream is authoritative for application messages and third-party Commits, and the documents converge sibling Commits under the forward-only epoch check, conflicting documents cannot corrupt local MLS state. (The §10 symmetric within-group race is not a CRDT failure: two MLS states at the same epoch have no merge function, so no CRDT can resolve them.)
- **Tombstone durability.** Tombstones live in the meta document, advertised through a single permanent tip slot independent of the live-group list, so a tombstoned group cannot be resurrected by a peer merely because its live `x` tag was evicted from the tip. A stale tombstone propagating from a behind device binds only devices at epoch ≤ its own (§8); it cannot corrupt or delete newer state.
- **Key-package private keys.** The `lastResortKeyPackage` entry (§4.2) carries init, leaf-encryption, and signature private keys inside the same DEK seal (§7) as group state; it adds no new exposure. Reusable-key-package add-spam is inherent to publishing a last-resort key package (RFC 9420 §17.2) — present for a single device too — and is not worsened by replication.

Not protected (inherent to the shared-leaf model):

- **Soft-delete is not MLS removal.** A tombstone (§8) stops devices _tracking_ a group; it does not end MLS membership. The identity remains a member, the coordinator may still deliver the group's messages (they are simply not fetched), and a sibling's Commit raises the epoch and resurrects the group (§10). Ending membership on every device requires an MLS Leave (§11).
- **No per-device post-compromise security.** Compromising one device compromises the shared leaf for every group until the user rekeys each group. An MLS Update/Commit from any device rekeys the leaf for all devices.
- **No per-device revocation.** Removing a user from a group removes all devices. See §11.
- **Device-count and inventory leakage.** The ratchet tree reveals one leaf per user regardless of device count. The sealed tip inner event's size grows with the number of live groups (one typed `x` each), so a relay observes an approximate live-group count via ciphertext length; the meta document's size approximates tombstone count and key-package presence. The store can observe which devices fetch which addresses and when.
- **Tip unlinkability is bounded.** The opaque tip (§6) defeats naive relay-side linking to the owner, but does not hide activity from an adversary that holds the connection string, nor from a global network observer. The content-store fetch necessarily exposes the blob address to the store; ephemeral store auth (§12) prevents linking the fetch to the owner `npub` but cannot hide that _some_ device fetched _that_ address.
- **Sibling-Commit ingestion hazard.** A client that fails to skip its own identity's Commits on the stream will mark itself removed from the group (§10). This is a correctness requirement, not a defense-in-depth measure.
- **`nsec` is load-bearing.** The tip is NIP-44-sealed to the owner `npub` and the DEK lives inside it (§7), so anyone with the `nsec` obtains the DEK and decrypts every document, and, independently, can impersonate the leaf. This is the same trust root the rest of `cordn` already assumes; multi-device does not add a new one.

### 14. Interoperability Requirements

Implementations MUST agree on all of the following:

- the two document JSON shapes and field semantics in §4 (group document §4.1, meta document §4.2), including the `type` discriminator
- the document seal (§7): NIP-44 v2 self-seal to a per-identity DEK (a Nostr keypair), with the DEK private key carried in the tip's `dek` tag
- content addressing by `sha256(blob)` where `blob` is the sealed document (§6)
- the reconciliation rule in §8: per `gid`, the highest-epoch fact wins — seed missing groups, fast-forward present groups only to a strictly newer epoch, clear a tombstone only on a strictly-higher-epoch present fact, apply tombstones only at ≥ the local epoch, never downgrade
- the reconcile invariant (§8): a `gid` in the tip's live list MUST be resolved against its group document even if locally tombstoned
- the inventory invariant (§4.3): a `gid` appears live XOR tombstoned, never both at the same tip
- the `removed` tombstone shape `{gid, epoch}` in the meta document (§4.2)
- the group-seeding procedure and the use of `cursor` as the starting `afterCursor` (§9)
- the §10 rule that a device MUST NOT ingest a Commit whose sender leaf index equals its own (sibling-skip), and that the committing device MUST publish a new group document for that group after any epoch-advancing operation
- the tip content format (§6): a NIP-44 seal of an owner-signed inner Nostr event whose typed `x` tags list each live group document (`["x", sha256, "group", gid]`) and the meta document (`["x", sha256, "meta"]`), whose single `dek` tag carries the 64-hex-char DEK private key (§7), and whose `server` tags list the Blossom hosts ([BUD-08](https://github.com/hzrd149/blossom/blob/master/buds/08.md), [BUD-03](https://github.com/hzrd149/blossom/blob/master/buds/03.md))
- when using the RECOMMENDED tip transport (§6), the replaceable-event `kind` (a coordination detail all clients must agree on); the `d` value, ephemeral pubkey, and relay set are per-identity and travel in the connection string

Implementations MAY choose any tip transport that resolves a current document set for an owner (§6). Tip transport choice does not affect interoperability of the documents themselves.

### 15. Rationale

The model is intentionally minimal and reuses existing `cordn` primitives.

- **Shared leaf over per-device leaves.** Per-device leaves (RFC 9420 §5.2) provide per-device post-compromise security and revocation but require a Welcome per device per group, grow the ratchet tree with device count, and reveal device count to other members. The shared-leaf model accepts the security trade for simpler UX, a smaller tree, and concealed device count.
- **Per-group documents.** State is split one document per live group so that a change to one group republishes only that group's document, decouples concurrent commits in different groups (neither clobbers the other's document), and makes offline catch-up (§8.5) walk a single group's chain rather than a mixed multi-group snapshot. Dedup is at the publish-decision layer (§10.5), so no deterministic seal is needed.
- **Meta document for identity-level state.** Tombstones and the last-resort key package are not properties of any one group; they are identity-level. Carrying them in a single meta document — advertised through one permanent tip slot — keeps the live-group tip list bounded by _current_ groups rather than lifetime groups, and makes tombstones durably discoverable independent of which groups are currently live (§13). It is a current-state set with no `prev` chain (§4.2).
- **Seed-and-fast-forward, not merge.** MLS `ClientState` has linear history and cannot be merged. Missing groups are seeded; present groups fast-forward to a strictly newer epoch; equal-or-older documents are advisory. The forward-only epoch check makes the design rollback-safe without ever fusing two live states. Reconciliation is a CvRDT (§8); the within-group symmetric race (§10) is out of its reach, since equal-epoch MLS states have no merge function.
- **Tombstones for removal, not absence.** A group missing from the tip is ambiguous (deleted vs. not-yet-known), and a naive absence-as-removal rule would flap. An explicit `removed` tombstone `{gid, epoch}` in the meta document disambiguates and propagates deletion the way live group documents propagate presence. Epoch — not cursor, not wall-clock — is the ordering primitive: it advances only on a deliberate Commit, so a tombstone is overridden only by genuine re-engagement (rejoin, or a sibling Commit), never by passive message flow; and it is the forward-only guard that keeps a replayed old tombstone from deleting newer state. Soft-delete is layered above MLS — it stops devices tracking a group without ending membership — leaving MLS Leave (§11) as the permanent-removal operation.
- **Group document carries full `clientState`.** This is forced by the shared-leaf Commit semantics in §10: a sibling's Commit cannot be ingested from the stream, so the new leaf private keys must travel in the document. Cursors alone would not suffice.
- **Blossom blobs, sharded by concern.** Each document is small JSON; content-addressed single-blob storage per document is the simplest mechanism that satisfies the addressing and immutability requirements, and it is already used by [`encrypted-media.md`](encrypted-media.md). Sharding stops at one blob per group + one meta blob (§12).
- **Last-resort key package replication.** A Welcome is bound to one key package, so in the shared-leaf model only the publishing device can process it; an offline publishing device stalls the Welcome even with siblings online. Carrying the account's single last-resort key package in the meta document lets any device process a Welcome to it (§11.5).
- **Hardened, opaque tip transport.** The tip is a lookup, so any transport interoperates; a hardened Nostr replaceable event is RECOMMENDED because it keeps the coordinator content-opaque AND hides the owner's `cordn` usage and identity from passive relay observers. The ephemeral signer is independent (not derived) so knowledge of the owner `npub` cannot reveal the tip. Typed `x` tags carry the document inventory and the `gid`, enabling fetch-only-what-changed without leaking anything beyond ciphertext length.
- **DEK-sealed documents; authenticity via the tip.** Sealing each document directly to the owner `npub` with NIP-44 would bind every document decrypt to the owner `nsec` — a per-document signer roundtrip that is crippling on a remote (NIP-46) signer over poor connectivity, and multiplied by group count and catch-up chain depth (§8.5). A per-identity DEK (a Nostr keypair) carried inside the tip's NIP-44 seal decouples document confidentiality from the signer: one NIP-44 decrypt per tip read yields the DEK, after which every document decrypt is a local decrypt using a key the device already holds. The DEK adds no new trust root — it inherits the tip's authenticity (owner-signed inner event) and confidentiality (NIP-44 seal to owner `npub`) — and it is kept independent of the ephemeral signing key so that key's bounded-tier property (§6) is preserved. The tip remains the single NIP-44-to-owner operation, so the owner `npub` still appears only inside the tip's seal, keeping documents pure data blobs and concentrating all signing in the tip.
- **Connection string over pairing ceremony.** Bootstrapping a device must convey _something_ (a locator and write capability). A scannable `naddr` + ephemeral `nsec` string is the minimal such conveyance — offline, one-shot, no handshake — avoiding the mutual key-agreement UX the model otherwise rejects.
- **`prev` as per-group history and catch-up.** Group documents converge via the newer-epoch rule; the per-group chain additionally lets a stale device recover the messages a single fast-forward would lose (§8.5), by replaying one `ClientState` per skipped epoch for that group alone. The chain earns its place both as an immutable, authenticated log on the content store and as the offline-catch-up engine.
