# @cordn/test-utils

## 0.5.5

### Patch Changes

- 11f3b58: Bump `@contextvm/sdk` to 0.14.2 across cli, server and test-utils. The transport now de-duplicates plaintext requests by event id as well: a request carried by N relays is processed (and stored) once in both transport modes, fixing the duplicate-cursor "generation in the past" failures for the default `disabled` mode. Same-second byte-identical repeats are dropped by design (no nonce); recovery is caller-driven — see `packages/cli/docs/SECURITY.md`.

## 0.5.4

### Patch Changes

- Updated dependencies [7eb87bf]
  - @cordn/core@0.5.6

## 0.5.3

### Patch Changes

- Updated dependencies [cdfbced]
  - @cordn/core@0.5.4

## 0.5.2

### Patch Changes

- Updated dependencies
  - @cordn/core@0.5.2
