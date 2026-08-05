# @cordn/core

## 0.5.5

### Patch Changes

- fix(core): drop Buffer from public codec, make @cordn/core browser-safe

  groupRef.ts and base64.ts used Node's `Buffer` global (hex decode/encode,
  concat, base64), so browser consumers without a Buffer polyfill threw
  `ReferenceError: Buffer is not defined` when calling `encodeGroupRef` /
  `decodeGroupRef` (or the base64 codec).

  Replace each `Buffer` call with a browser-safe helper from a dependency
  already in core — no new dependencies:
  - hex/concat: `bytesToHex` / `hexToBytes` / `concatBytes` from `@noble/hashes/utils.js`
  - base64: `base64` from `@scure/base`

  npm 0.5.4 carries the Buffer bug; this ships as 0.5.5. Verified: 299/299
  tests, zero `Buffer` in emitted dist, and a sim with `Buffer` removed
  from globalThis round-trips groupRef + base64 cleanly.

## 0.5.4

### Patch Changes

- cdfbced: fix(core): declare @noble deps, ship compiled dist, add MIT license

  Fixes a consumer crash: ts-mls imports @noble/hashes (sha2/hmac) and
  @noble/ciphers (aes) at runtime but declares them only as devDep/peer,
  so installs of @cordn/core got neither. Declare both as direct deps
  (pinned to ts-mls's 2.2.0 contract).

  Package hardening for the public release:
  - build ESM .js + .d.ts to dist/ via tsc; repoint main/types/exports
    so plain-Node/JS consumers work without a TS toolchain
  - sideEffects: false (source verified pure) -> tree-shakeable
  - files: ["dist"] -> no test files or source in the tarball
  - exports map, engines (>=20.12), description, repository/bugs/keywords
  - MIT license + LICENSE file + README

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
