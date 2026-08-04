# Cordn Group Reference

- Status: Draft

## Abstract

This document defines the `cordn` group reference: a single bech32-encoded string that carries the coordinates a client needs to discover a group and act on it — a delivery group identifier (`gid`) together with an optional coordinator public key and optional relay hints. It exists to give group sharing a stable, unambiguous, interoperable wire form, replacing ad-hoc combinations of opaque `gid` strings and `nprofile` relay hints inside shareable URLs.

The group reference is a pure client-side interop primitive. The coordinator is unchanged: it continues to treat `gid` as opaque, as required by [`spec/03.md`](../03.md). The coordinator never decodes, validates, or interprets a group reference, and this document introduces no coordinator protocol surface.

This document specifies only the encoding, field semantics, and embedding model. Coordinator roles, cursor semantics, and the definition of `gid` are defined in [`spec/00.md`](../00.md) and [`spec/03.md`](../03.md). The join-request workflow that a consumer of a group reference typically triggers is defined in [`join-requests.md`](join-requests.md). Client-side MLS processing and user experience are out of scope.

## Specification

### 1. Overview

A group reference packages the three coordinates a client needs to reach a group into one checksummed string.

- A group reference encodes a `gid`, an optional coordinator public key, and zero or more relay hints.
- A group reference is encoded with bech32 using the prefix `cordn`, producing strings beginning with `cordn1…`.
- The encoding follows the [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md) TLV convention used by `nprofile` and `naddr`, so existing Nostr tooling and familiarity transfer directly.
- A group reference is a client-side artifact. The coordinator never parses it; `gid` remains opaque to the coordinator as required by [`spec/03.md`](../03.md).
- A group reference does not authorize anything. It is a locator. Authorization, group existence, and membership are handled by the existing coordinator protocol surface.

### 2. Bech32 Encoding

A group reference is a bech32 string.

- The human-readable prefix MUST be `cordn`. Encoded strings therefore begin with `cordn1`.
- The bech32 variant MUST be bech32 (checksum constant `1`), matching [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md) byte-for-byte. The bech32m variant MUST NOT be used.
- The maximum encoded length is 5000 characters, matching the NIP-19 limit. This is far above any realistic group reference and exists only to bound decoding work.
- Mixed-case strings MUST be rejected unless they are entirely uppercase or entirely lowercase, following the bech32 specification. Producers SHOULD emit lowercase.

A decoder MUST verify the checksum and MUST reject strings whose prefix is not exactly `cordn`.

### 3. TLV Structure

The bech32 data part is a concatenated Type-Length-Value (TLV) sequence, identical in structure to [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md) TLV. Each element is:

```
type (1 byte) || length (1 byte) || value (length bytes)
```

A group reference uses the following TLV types:

| Type | Name | Value | Multiplicity |
|------|------|-------|--------------|
| `0` | `gid` | UTF-8 encoded delivery group identifier | exactly one |
| `1` | `coordinator_pubkey` | raw 32-byte coordinator public key | zero or one |
| `2` | `relay` | UTF-8 encoded relay URL | zero or more |

Type `0` carries the primary identifier (`gid`), mirroring the role an `naddr` identifier plays in NIP-19 type `0`. Type `1` carries the coordinator public key as a 32-byte value, and type `2` carries a relay URL. The numbering places the coordinator public key below the relay on purpose: a relay entry names where to reach *that* coordinator, so it is only meaningful alongside a coordinator public key (see §5). No `kind` (NIP-19 type `3`) is defined; type `3` and all other types are reserved.

Producers SHOULD emit TLV elements in descending type order to match the NIP-19 reference encoding, but consumers MUST accept elements in any order. Consumers MUST ignore TLV types they do not recognize, so that future revisions can append new optional elements without breaking existing implementations. When multiple values for type `2` (relay) are present, all are collected in encountered order. A repeated type `0` or type `1` is invalid (see §5).

### 4. Field Semantics

#### 4.1 `gid`

- TLV type `0`. The delivery group identifier, as defined in [`spec/03.md`](../03.md).
- Encoded as UTF-8. The `gid` is opaque to the coordinator and MAY be any non-empty byte string at the application layer; this document requires only that it is valid UTF-8 of bounded length.
- The encoded value MUST round-trip byte-for-byte to the `gid` the producing client uses for posting, fetching, and subscribing. A consumer MUST treat the decoded value as its `gid` without any transformation, trimming, or re-encoding.
- This document places no structural interpretation on `gid`. It is not assumed to be a UUID, a hash, or an MLS `group_id`, and it MUST NOT be confused with any of these. The relationship between `gid` and MLS group state is a client convention defined in [`spec/03.md`](../03.md).

#### 4.2 `coordinator_pubkey`

- TLV type `1`. The public key of the coordinator that serves the group's delivery stream, as a raw 32-byte value.
- Encoded as exactly 32 bytes, matching the NIP-19 convention for public keys. Producers and consumers convert between raw bytes and the canonical Nostr hex encoding at the boundary.
- OPTIONAL. A group reference MAY omit it, for example when the consuming client is expected to reach the group through a configured default coordinator, or when the reference is consumed in a context that already knows the coordinator.
- For a shareable group link intended to cross client boundaries (see §6), the coordinator public key SHOULD be present. Omitting it delegates coordinator selection to the consumer and reduces the reference's portability.

#### 4.3 `relay`

- TLV type `2`. A relay URL, encoded as UTF-8.
- Reuses the NIP-19 relay semantics: zero or more entries, each a WebSocket (`wss://` or `ws://`) URL where the coordinator is reachable.
- Meaningful only alongside a coordinator public key (type `1`, see §4.2), since it names where to reach that coordinator. A reference carrying a relay without a coordinator public key is invalid (see §5).
- OPTIONAL. When absent, the consumer connects using its own relay discovery or configuration.

### 5. Validation Rules

A decoder MUST apply the following rules. Any violation makes the string an invalid group reference.

| Case | Behavior | Rationale |
|------|----------|-----------|
| bech32 checksum invalid | Reject | Integrity / typo detection |
| prefix is not exactly `cordn` | Reject | Distinguishes from other NIP-19 entities |
| bech32m variant used | Reject | Matches NIP-19; avoids silent variant mismatch |
| type `0` absent | Reject | `gid` is the reason the entity exists |
| type `0` present more than once | Reject | A reference names exactly one group |
| type `0` is empty | Reject | `gid` must be non-empty |
| type `0` longer than 255 bytes | Reject | Exceeds the 1-byte TLV length field (see §3) |
| type `0` is not valid UTF-8 | Reject | `gid` must be portable across clients |
| type `1` present more than once | Reject | A reference names at most one coordinator |
| type `1` length is not exactly 32 bytes | Reject | NIP-19 public-key convention |
| type `2` (relay) present without type `1` (coordinator public key) | Reject | A relay names where to reach a coordinator; without a coordinator public key it has no referent |
| type `2` is not valid UTF-8 | Reject | Relay URLs must be portable |
| unrecognized TLV type | Ignore (continue) | Forward compatibility |

The 255-byte cap on `gid` is not arbitrary: it is the maximum value that fits in the 1-byte TLV length field (see §3), and is therefore the same hard limit NIP-19 imposes on any TLV value. It is an encoding-time bound for all interoperable group references. It does not relax the coordinator's existing treatment of `gid` as opaque, and it does not constrain how a client derives its `gid`.

A producer SHOULD NOT emit an empty `relay` value. Consumers MAY discard empty `relay` values rather than treating them as a validation error.

### 6. Shareable Links and Embedding

A group reference is a protocol-level coordinate, not a URL. The two layers are kept separate on purpose.

- The group reference (`cordn1…`) carries only protocol coordinates: `gid`, optional coordinator public key, and optional relay hints.
- A shareable link wraps the group reference in an application-specific outer URL that handles client routing, onboarding, and presentation — for example `https://example.app/join#cordn1…` or `https://example.app/?g=cordn1…`.

Embedding guidance:

- A group reference placed in a URL fragment (`#cordn1…`) is preferable to a query parameter, because fragments are not sent to servers in ordinary request logs, reducing incidental leakage of the coordinates.
- The outer URL scheme, host, path, and any onboarding behavior are application-defined and out of scope for interoperability. Only the embedded `cordn1…` string is normative.
- A group reference MAY also appear outside a URL — for example as a QR code payload, a copy-pasted string, or a deep-link parameter — provided the consumer decodes it as specified.

This document defines no URI scheme of its own. The NIP-21 `nostr:` prefix is not applicable, because a group reference is not a Nostr entity.

### 7. Relationship to NIP-19 and `nprofile`

A group reference intentionally mirrors [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md) rather than inventing a new binary framing.

- `nprofile` encodes a public key plus relay hints and is used to share a *coordinator* (an identity that can be added to a client). A group reference encodes a `gid` plus the same optional public key and relay hints and is used to share a *group* served by a coordinator.
- A group reference is a superset of `nprofile` for the group-discovery case: it carries the same coordinator public key and relay hints as `nprofile`, and adds `gid` as the primary identifier. The field semantics match NIP-19 even though the cordn type numbers differ, because the type numbers are labels within the TLV scheme rather than a semantic contract — NIP-19 entities themselves assign different meanings to the same type number (type `0` is a public key in `nprofile` but an identifier in `naddr`).
- Reusing the NIP-19 TLV structure means existing Nostr libraries and developer familiarity transfer directly. Implementations MAY reuse a NIP-19 bech32 and TLV codec, changing only the prefix and the TLV type interpretation.

The distinct prefix (`cordn` rather than `nprofile`) is required: a group reference is semantically not a Nostr profile, and tools that dispatch on NIP-19 prefixes must not misinterpret it as one.

### 8. Share versus Invite Semantics

A group reference is a single entity. The application-level distinction between a "share" and an "invite" is a client-side workflow choice, not an encoding difference, and this document does not define separate prefixes or type flags for them.

The distinction resolves as follows:

- A **share** workflow is requester-initiated. The recipient consumes the group reference, publishes a KeyPackage, and submits a join request ([`join-requests.md`](join-requests.md)). The group reference is fully self-contained for this flow.
- An **invite** workflow is member-initiated. An existing member stores a Welcome addressed to a specific invited identity ([`welcome-delivery.md`](welcome-delivery.md)). A Welcome is identity-bound: the inviter must know (or fetch) the invitee's KeyPackage, and the invitee must have published one. This binding cannot be pre-baked into a static string, because the invitee's identity is not known when the reference is created.

Consequently, a static "invite code" reduces to the same coordinates as a share: `gid`, coordinator public key, and relay hints. The only difference is which workflow the consuming client triggers when it opens the reference. Applications select that workflow through their own UX (for example an outer URL path such as `/share/<code>` versus `/invite/<code>`, or a button label), not by encoding two different bech32 entities.

Producers and consumers MUST NOT assume that the presence or absence of a coordinator public key or relay hint carries share-versus-invite semantics. Those fields are locators only.

### 9. Interoperability Requirements

Implementations MUST agree on all of the following:

- The `cordn` bech32 prefix and the bech32 (not bech32m) checksum variant.
- The TLV structure and the assignment of types `0`, `1`, and `2`.
- The `gid` round-trip: the decoded `gid` is used verbatim, with no transformation.
- The 32-byte raw encoding of the coordinator public key in type `1`.
- Forward-compatible decoding: unknown TLV types are ignored, and elements are accepted in any order.
- The validation rules in §5.

Implementations MUST reject malformed references and MUST NOT silently fall back to interpreting an invalid string as a bare `gid`.

### 10. Rationale

- **Why bech32, and why NIP-19 shape.** The MLS-Nostr ecosystem already converged on NIP-19 TLV for shareable, checksummed entities. Reusing it gives immediate tooling and familiarity, gives every reference an integrity check (catching copy and transcription errors that an opaque `gid` in a URL cannot), and keeps the encoding trivially auditable.
- **Why one prefix, `cordn`, not `cordng`.** NIP-19's own precedent is one distinct prefix per entity (`npub`, `nprofile`, `naddr`, …), never a shared umbrella prefix. The group reference is the primary — and currently only — cordn bech32 entity. A second prefix can be minted later if a genuinely distinct entity appears, with no rename of the existing one.
- **Why `gid` as UTF-8 in type `0`, not a fixed-length hash.** `gid` is opaque to the coordinator and in practice is often a UUID or other application string. Encoding it as UTF-8 in the NIP-19 "primary identifier" slot (as `naddr` encodes its identifier) preserves every existing `gid` convention without mandating a hash derivation.
- **Why the coordinator public key is optional.** Some clients reach groups through a configured default coordinator and benefit from shorter references. Making the field optional accommodates those clients while still recommending its presence in cross-client share links, where it materially improves portability.
- **Why share and invite are not separate encodings.** An invite is identity-bound and cannot be pre-encoded; a static "invite code" is therefore the same coordinate set as a share, differing only in client workflow. Baking the distinction into the prefix would duplicate a coordinate set for no interoperability gain and would force every consumer to understand both.
- **Why the coordinator is unchanged.** Keeping `gid` opaque and keeping reference decoding entirely client-side means this document adds no coordinator protocol surface, no contract changes, and no new trust assumptions. The reference is a locator, and authorization continues to flow through the existing coordinator methods.
- **Why embedding is layered.** Separating the protocol coordinate (`cordn1…`) from the application outer URL lets each client own its onboarding and routing while sharing one interoperable core, mirroring how `nprofile` is embedded in coordinator-share URLs today.
