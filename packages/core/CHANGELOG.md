# @cordn/core

## 0.5.2

### Patch Changes

- feat(core): add bech32 cordn group reference codec

  Add encodeGroupRef/decodeGroupRef/isGroupRef for `cordn1…` group
  references: a bech32 (NIP-19-style TLV) encoding of a delivery gid
  plus optional coordinator pubkey and relay hints, giving group shares
  a checksummed, interoperable wire form instead of ad-hoc gid+URL pairs.
  - TLV mirrors NIP-19: type 0 gid (UTF-8), type 1 coordinator pubkey
    (32 bytes), type 2 relay (repeatable). Relays are only valid
    alongside a coordinator pubkey and are rejected otherwise; unknown
    TLV types are ignored for forward compatibility.
  - Symmetric encode/decode validation per spec/applications/group-ref.md.
  - Adds @scure/base; codec lives with the other leaf codecs in
    @cordn/core and is exported from the barrel.
  - 27 tests, including three golden vectors cross-validated against an
    independent @scure/base TLV assembly.

  Also corrects the group-ref spec's gid cap from 256 to 255 bytes: the
  1-byte TLV length field carries at most 255, so 256 was unencodable.
  The decode-side length check is dropped as unreachable (any gid in a
  well-framed TLV entry is ≤255 by construction).
