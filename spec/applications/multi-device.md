# Cordn Multi-Device Synchronization

- Status: Draft

## Abstract

This document defines how `cordn` clients keep multiple devices of one identity synchronized without server-side key material or coordinator changes. Devices of a single user share one MLS leaf (one `ClientState` per group). They converge on application messages and third-party Commits by replaying the same opaque delivery stream defined in [`spec/03.md`](../03.md), and converge on sibling-device Commits by adopting a newer-epoch `ClientState` carried in a sealed *session document* — because a sibling's Commit cannot be ingested from the stream. The document is stored as a content-addressed blob, addressed by `sha256` of its canonical encoding, and advertised through a mutable, opaque tip pointer whose transport hides the owner's identity and `cordn` usage from passive observers. The coordinator is unchanged: it continues to treat group messages as opaque bytes, as required by [`spec/03.md`](../03.md).

This document specifies the session document format, the seal-and-sign content-protection model, the seed-not-merge reconciliation rule, the cursor semantics that let a freshly-seeded device catch up, a RECOMMENDED hardened tip transport, and a connection-string device-addition flow. On-device MLS state storage is out of scope; alternative tip transports remain interoperable because the tip is a lookup.

## Specification

### 1. Overview

Multi-device reuses the delivery model of [`spec/03.md`](../03.md) for a separate concern: converging per-group client state across devices of one identity.

- A user's devices share a single MLS leaf per group: one `ClientState`, one membership, one set of per-epoch secrets.
- Application messages and Commits authored by other members converge via the per-group ordered delivery stream. A Commit authored by a sibling device (same leaf) does NOT: the committing device re-publishes, and siblings fast-forward their `ClientState` to the newer epoch from the document.
- A sealed *session document* snapshots each group's MLS state and delivery cursor. Its only purpose is to seed groups a device does not yet have and to advertise which groups exist.
- The document is signed by the owner and encrypted (sealed) to the owner's own Nostr public key, stored on a content-addressed store chosen by the client, and addressed by `sha256` of its canonical encoding. [Blossom](https://github.com/hzrd149/blossom) is RECOMMENDED.
- A mutable, opaque *tip* (§6) advertises the current document address. Devices fetch the tip, fetch the document, decrypt, verify the signature, and reconcile.

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

The session document is a JSON object. Its purpose is to seed groups on devices that lack them and to advertise the set of groups the identity belongs to. It is not a log of messages and does not carry identity private keys.

```json
{
  "schemaVersion": 1,
  "issuedAt": 0,
  "prev": "<hex sha256 of previous document>",
  "signature": "<hex schnorr signature by owner over canonical bytes excluding this field>",
  "groups": [
    {
      "gid": "<delivery group id, per spec/03 §2>",
      "coordinator": "<coordinator identity or key>",
      "metadata": { },
      "encrypted": true,
      "clientState": "<base64 of serialized MLS ClientState>",
      "cursor": 0
    }
  ]
}
```

Field requirements:

- `schemaVersion` MUST be `1`. Clients MUST reject documents with an unknown schema version.
- `issuedAt` is wall-clock milliseconds and is advisory; it is not a security primitive.
- `prev` SHOULD be populated with the `sha256` of the canonical encoding of the previous document. It forms a hash chain that, because the content store is immutable and content-addressed (§12), is walkable: each parent blob is retained and fetchable. This yields a tamper-evident, owner-authenticated history useful for forensics and recovery (§13). The chain is NOT consulted during reconciliation (§8); convergence uses the newer-epoch rule alone.
- `signature` MUST be a valid Schnorr signature by the owner over `sha256(canonical_json(document with this field removed))`. It is the document's authenticity guarantee (§7). Clients MUST reject any document whose signature does not verify under the receiver's own npub; the receiver is the owner, so the verifying key is the npub that decrypted the seal.
- `groups[].gid` is the delivery group identifier ([`spec/03.md`](../03.md) §2), opaque to the coordinator and distinct from the MLS `group_id`.
- `groups[].coordinator` is the coordinator identity or public key that serves `gid`, so a seeded device knows where to fetch the delivery stream.
- `groups[].metadata` is OPTIONAL and carries the group's `CordnGroupMetadata` ([`spec/01.md`](../01.md)) for presentation only; authoritative metadata is what the receiver derives by replaying the stream.
- `groups[].encrypted` records whether the group uses end-to-end encrypted payloads ([`spec/03.md`](../03.md)); the seeded device adopts it as the group's outbound encryption mode.
- `groups[].clientState` is the base64 encoding of the serialized MLS `ClientState` for that group at the instant the document was written.
- `groups[].cursor` is the writer's last-processed delivery cursor for that `gid` at the same instant. The `(clientState, cursor)` pair MUST be a consistent snapshot: ingesting the delivery stream up to and including `cursor` MUST leave the writer at the epoch encoded in `clientState`.

The document MUST NOT carry the identity's Nostr private key (`nsec`), key packages, pending welcomes, join requests, or messages. Devices are responsible for provisioning their own access to the identity, typically via a remote signer. The document converges *group state* only; it does not provision *identity*.

### 5. Canonical Encoding

The document MUST be encoded as canonical JSON for the purposes of content-addressing (§6):

- UTF-8, object members in lexicographic code-point order by name, no insignificant whitespace.
- [RFC 8785](https://datatracker.ietf.org/doc/rfc8785/) is RECOMMENDED. Clients MAY store and transmit non-canonical JSON internally; canonicalization is required only when computing the document address.

### 6. Content-Addressing and the Tip

The document address is `sha256` of the canonical document encoding, lowercase hex. The address doubles as the content-addressed store key (e.g. the Blossom blob hash).

- The stored blob is the *sealed* document (§7). Its address is `sha256(blob)`.
- Clients MUST verify, after fetching, that `sha256(fetched bytes)` equals the advertised address. Mismatch MUST be rejected.
- The *tip* is the mutable pointer to the current document address. Devices read the tip to learn which address to fetch, and write the tip after publishing a new document.
- The tip transport is not normative, but a hardened Nostr replaceable event is RECOMMENDED (below). Any mechanism that resolves "current document address for this owner" is interoperable, because the tip is a lookup, not a protocol primitive; an out-of-band channel is an acceptable alternative.

**RECOMMENDED tip transport — an opaque replaceable event.** The owner's `npub` signs nothing on the network for this feature. The tip is a NIP-33 parameterized replaceable event signed by an **ephemeral keypair independent of the owner identity**:

```jsonc
{
  "kind": 30078,            // application-specific; exact kind is a coordination detail (§14)
  "pubkey": "<ephemeral pubkey>",
  "content": "<NIP-44 v2 to owner npub: current document address + optional store hint>",
  "tags": [
    ["d", "<random opaque value, generated once>"]
  ],
  "created_at": 0,
  "sig": "<ephemeral key signature>"
}
```

- The `d` tag is random and **stable across republishes** (with the ephemeral pubkey it is the replaceable dedup key). Generated once and reused, it avoids cross-user fingerprinting; a per-publish value would break replaceability and accumulate events.
- The ephemeral signing key MUST be independent of the owner `nsec`. Deriving it is an anti-pattern: a public derivation scheme would let anyone compute the signing pubkey from the owner `npub` and query for the tip, defeating the unlinkability that motivates the design.
- The `content` is NIP-44-encrypted to the owner `npub`, so the event leaks nothing public beyond "some ephemeral account updates an opaque, randomly-tagged event" — no link to the owner, no link to `cordn`.
- Relays resolve the event by `(ephemeral pubkey, d)` and serve the greatest `created_at`. A device reads the tip, NIP-44-decrypts with its owner `nsec`, and obtains the document address. `created_at` is author-set; a far-future value cannot corrupt state (content is encrypted and documents are epoch-checked), only deny service transiently.
- The ephemeral `nsec` is a bounded-tier secret: leaking it can move the tip but cannot decrypt, forge, or downgrade state — denial-of-service only (§13).

**Connection string.** Locating the tip (a NIP-19 `naddr`: kind + ephemeral pubkey + `d` + relay hints) and the write capability (the ephemeral `nsec`) travel together in a single connection string minted by an existing device. It carries no owner key material. See §11 for the bootstrap flow and rotation.

### 7. Document Sealing

The session document is sealed to the owner's own Nostr public key using [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) v2 encryption.

```
# Sign-then-encrypt: the signature (§4) covers canonical_json(SessionDoc)
# with the signature field removed, and travels inside the seal.
sealed  = nip44_v2.encrypt(ECDH(owner_nsec, owner_npub),
                           canonical_json(SessionDoc))   # includes signature
blob    = utf8(sealed)
address = sha256(blob)
```

Requirements:

- The document MUST be encrypted to the owner's own `npub`. Any device holding the `nsec`, or fronted by a signer able to perform the ECDH, can decrypt. No pairing, pre-shared key, passphrase, or additional KDF is defined.
- The sender and recipient public keys are equal; the NIP-44 payload's encrypted sender field therefore reveals only that the owner addressed itself.
- The MLS exporter is intentionally not used. The session document spans all of a user's groups and is not a payload of any single group; there is no single epoch secret to derive from. Reusing NIP-44 keeps content protection tied to the identity the user already manages.

The seal provides **confidentiality only**: NIP-44 to self does not authenticate the sender, since anyone can encrypt to the owner `npub`. Authenticity is provided by the `signature` field (§4): the owner signs the canonical document (including `prev`) and the signature travels inside the seal, so the owner `npub` is never exposed on the content store. Sign-then-encrypt is mandatory; signing the ciphertext would bind the blob to the owner `npub` and leak the identity. A recipient decrypts, then verifies the signature before any MLS work — a cheap outer authenticity gate. The four properties are distinct: NIP-44 = confidentiality, signature = authenticity, MLS validity = coherence, §8 epoch check = anti-downgrade. Replay and rollback protection is provided by §8, not by the seal.

### 8. Reconciliation

A device reconciles an incoming document against its local state.

For each entry in `groups`:

- If the device does NOT have a local group with that `gid`, it MUST seed the group from the entry (§9), using `clientState` and `cursor` as the seed.
- If the device already has a local group with that `gid`, it MUST compare the entry's epoch to its local epoch:
  - If the entry's epoch is strictly greater, the device MUST fast-forward: adopt the entry's `clientState` and advance its local delivery cursor to `max(local, entry.cursor)`. Fast-forwarding is how sibling Commits propagate (§10), because the serialized `clientState` carries the new leaf private keys that the delivery stream cannot convey.
  - Otherwise (equal or older epoch) the entry is advisory and the device MUST ignore its `clientState`, `cursor`, and `metadata`.

The newer-epoch check is the rollback defense and is load-bearing. The document is authoritative for group existence, for seeding missing groups, and for fast-forwarding to a strictly newer epoch; it is never authoritative for downgrading state. In particular:

- The device MUST NOT adopt a `clientState` whose epoch is less than or equal to the local epoch. This prevents a replayed, rolled-back, or stale tip from overwriting newer local state.
- The device MUST NOT advance an existing group's local delivery cursor past what the adopted `clientState` warrants. Fast-forward advances the cursor to the entry's `cursor` because the adopted state has processed through that point.
- A group is "already present" if it exists locally, even one the device has marked removed or poisoned. A document entry cannot un-remove such a group unless it carries a strictly newer epoch — the newer `clientState` is itself proof of renewed membership.

After reconciling, if the device holds groups not represented in the document, or local epochs ahead of the document for shared groups, the device SHOULD publish a new document that merges its local state with the received set. To avoid lost updates under concurrent writers, the device MUST fetch the current tip, decrypt, merge locally (taking the newer epoch per group), then publish-and-advise. Last-tip-wins is acceptable because per-group epoch comparison makes concurrent publication converge.

### 9. Group Seeding

Seeding installs a group on a device without the Welcome flow defined in [`welcome-delivery.md`](welcome-delivery.md), because the device is adopting the shared leaf rather than joining as a new member.

To seed an entry:

1. Deserialize `clientState` into a local `ClientState`.
2. Record `gid`, `coordinator`, `metadata`, and `encrypted` as the group's local presentation and routing data.
3. Set the local delivery cursor for `gid` to the entry's `cursor`.
4. Begin normal fetch progression from `afterCursor = cursor` as defined in [`spec/00.md`](../00.md) §5 and [`spec/03.md`](../03.md).

The `cursor` is the writer's fetch progression, not the membership boundary (that role belongs to the Welcome `after` hint in [`welcome-delivery.md`](welcome-delivery.md) §2). The seeded device inherits the writer's current group state through `clientState` and receives messages posted after `cursor`; messages at or before `cursor` are not re-fetched. This is the intended state-sync trade: a freshly-seeded device converges on group state immediately and on message content from `cursor` forward, without the document carrying message history.

After seeding, the device catches up by ingesting the delivery stream. Application messages and Commits authored by OTHER members are processed normally. A Commit authored by a sibling device (same leaf) cannot be ingested from the stream (§10); the seeded device relies on document fast-forward for those.

### 10. Convergence and Sibling Commits

The coordinator delivery stream and the session document each carry part of the truth. Convergence splits along who authored a Commit:

- **Application messages** converge via the delivery stream. Any device sharing the leaf can decrypt and process them, because they are sealed under the shared epoch key and the leaf's private keys are identical across devices.
- **Commits authored by other members** converge via the delivery stream. Every device is an ordinary member relative to another member's leaf and processes those Commits normally.
- **A Commit authored by a sibling device (the same shared leaf) does NOT converge via the delivery stream.** A Commit refreshes the committer's leaf with new HPKE keys via an UpdatePath; only the committer receives the corresponding private keys (from `createCommit`). A sibling device that tried to ingest the Commit would update its leaf's public keys to the committer's new keys without holding the private keys, which MLS surfaces as the member being removed from the group. Therefore:
  - A device MUST NOT ingest a Commit whose sender leaf index equals its own. Such a Commit is a sibling Commit; the device MUST skip it on the stream (advance the cursor, do not process, do not mark itself removed) and await convergence through the document. The detection is exact, not heuristic: in the shared-leaf model a sibling occupies the device's own leaf index, which no third party ever does. The sender leaf index is available to the client even when ingestion subsequently fails, because the MLS authorization callback is invoked before the Commit's UpdatePath is applied.
  - The committing device MUST re-publish the document after any epoch-advancing operation so its siblings can fast-forward (§8). A client SHOULD expose this as a single hook fired when a locally-authored Commit is confirmed via self-echo (and on group creation), wired to re-publish the document. The hook is fire-and-forget: publishing latency MUST NOT block delivery.
  - Receiving devices converge by adopting the document's newer-epoch `clientState`, which carries the new leaf private keys.

This split is the defining operational property of the shared-leaf model. It is why the document must carry full `clientState` (not just cursors) and why the committing device bears the burden of re-publishing after membership or metadata changes. Application traffic — the common case — needs no re-publish.

Concurrent Commits across devices of the same identity fall into two cases:

- **Asymmetric (one device commits while its siblings are quiescent):** converges automatically. The siblings skip the Commit on the stream and fast-forward once the committing device re-publishes. This is the normal case.
- **Symmetric (two devices commit within the same delivery round-trip window, before either sees the other's Commit):** a race. Each device confirms its OWN Commit via self-echo and skips the sibling's, so both advance to epoch N+1 with different states. The forward-only epoch check (§8) cannot pick a winner because the epoch numbers are equal, so neither document fast-forwards the other. This is a known limitation of the shared-leaf model without a tiebreaker. Mitigations, in order of preference:
  1. Re-publish promptly so siblings fast-forward before staging their own Commit. A client SHOULD refuse to stage a Commit on a group that has skipped a sibling Commit but not yet fast-forwarded (the device is known to be behind the canonical state).
  2. Surface a conflict signal so the user can re-sync the diverged device from the canonical device's document.
  3. Full automatic resolution requires a cursor-based tiebreaker (the Commit delivered at the lower cursor wins) plus state rollback to the pre-Commit epoch. This is not specified here; it is disproportionate to the rarity (two devices performing admin on the same group within a sub-second window).

Application traffic and single-admin scenarios — the overwhelming majority — are unaffected by the race.

### 11. Device Addition and Removal

Adding a device is an identity-provisioning step, not an MLS operation. The new device obtains access to the owner's `nsec` (directly or via a signer) and is given a **connection string** (§6) by an existing device. From the string alone it bootstraps: parse the `naddr` to learn the relay(s), ephemeral pubkey, and `d`; fetch the replaceable tip event; NIP-44-decrypt its content with the owner `nsec` to obtain the current document address; fetch and content-address-verify the blob; decrypt and signature-verify the document; seed every group (§9). It then persists the ephemeral `nsec` so it can publish its own tip moves. No Welcomes are issued and group membership does not change, because the device adopts the existing shared leaf of each group.

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
- **Authenticity.** The owner `signature` (§4, §7) is the document's authenticity guarantee. It is verified cheaply, before any MLS work, and authenticates even an empty document that MLS validity cannot speak to. MLS `ClientState` validity remains as a second, per-state coherence gate.
- **Integrity and rollback defense.** Content-addressing plus the §8 newer-epoch rule mean a replayed or rolled-back tip cannot downgrade an existing group's `ClientState`, advance its cursor past the adopted state, or re-seed a group the device has already removed. A leaked ephemeral write key cannot forge an acceptable document (it lacks the owner `nsec` to sign); its only play is to repoint to stale or undecryptable blobs — denial-of-service, not corruption.
- **History.** The `prev` chain (§4) is a walkable, tamper-evident, owner-authenticated log on the immutable content store, useful for forensics and recovery. It is not a reconciliation or consensus mechanism.
- **Convergence.** Because the delivery stream is authoritative for application messages and third-party Commits, and the document fast-forwards sibling Commits under a forward-only epoch check, conflicting documents cannot corrupt local MLS state.

Not protected (inherent to the shared-leaf model):

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
- canonical JSON encoding (§5) for content-addressing
- NIP-44 v2 encryption to the owner's own `npub` as the seal (§7)
- content addressing by `sha256(blob)` where `blob` is the sealed document (§6)
- the reconciliation rule in §8: seed missing groups, fast-forward present groups only to a strictly newer epoch, never downgrade
- the group-seeding procedure and the use of `cursor` as the starting `afterCursor` (§9)
- the §10 rule that a device MUST NOT ingest a Commit whose sender leaf index equals its own (sibling-skip), and that the committing device MUST re-publish after any epoch-advancing operation
- the owner `signature` field and its verification (§4, §7)
- when using the RECOMMENDED tip transport (§6), the replaceable-event `kind` (a coordination detail all clients must agree on); the `d` value, ephemeral pubkey, and relay set are per-identity and travel in the connection string

Implementations MAY choose any tip transport that resolves a current document address for an owner (§6). Tip transport choice does not affect interoperability of the document itself.

### 15. Rationale

The model is intentionally minimal and reuses existing `cordn` primitives.

- **Shared leaf over per-device leaves.** Per-device leaves (RFC 9420 §5.2) provide per-device post-compromise security and revocation but require a Welcome per device per group, grow the ratchet tree with device count, and reveal device count to other members. The shared-leaf model accepts the security trade for simpler UX, a smaller tree, and concealed device count.
- **Seed-and-fast-forward, not merge.** MLS `ClientState` has linear history and cannot be merged. Missing groups are seeded; present groups fast-forward to a strictly newer epoch; equal-or-older documents are advisory. The forward-only epoch check makes the design rollback-safe without ever fusing two live states.
- **Document carries full `clientState`.** This is forced by the shared-leaf Commit semantics in §10: a sibling's Commit cannot be ingested from the stream, so the new leaf private keys must travel in the document. Cursors alone would not suffice.
- **Blossom single blob.** A session document is small JSON; content-addressed single-blob storage is the simplest mechanism that satisfies the addressing and immutability requirements, and it is already used by [`encrypted-media.md`](encrypted-media.md).
- **Hardened, opaque tip transport.** The tip is a lookup, so any transport interoperates; a hardened Nostr replaceable event is RECOMMENDED because it keeps the coordinator content-opaque AND hides the owner's `cordn` usage and identity from passive relay observers. The ephemeral signer is independent (not derived) so knowledge of the owner `npub` cannot reveal the tip.
- **Seal to self, signature for authenticity.** The user already manages an `nsec`, often via a remote signer; reusing NIP-44 to the owner `npub` adds no new key, no pairing step, and no new trust root — but provides confidentiality only. The owner signature adds authenticity at near-zero cost (the seal already needs the owner `nsec`) and, inside the seal, never exposes the owner `npub` on the wire.
- **Connection string over pairing ceremony.** Bootstrapping a device must convey *something* (a locator and write capability). A scannable `naddr` + ephemeral `nsec` string is the minimal such conveyance — offline, one-shot, no handshake — avoiding the mutual key-agreement UX the model otherwise rejects.
- **`prev` as history, not consensus.** Full-snapshot documents converge via the newer-epoch rule; walking the chain never helps a stale device get current. The chain earns its place as an immutable, authenticated log on the content store, not as a reconciliation engine.
