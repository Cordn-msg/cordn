# @cordn/server

## 0.5.8

### Patch Changes

- 11f3b58: Bump `@contextvm/sdk` to 0.14.2 across cli, server and test-utils. The transport now de-duplicates plaintext requests by event id as well: a request carried by N relays is processed (and stored) once in both transport modes, fixing the duplicate-cursor "generation in the past" failures for the default `disabled` mode. Same-second byte-identical repeats are dropped by design (no nonce); recovery is caller-driven — see `packages/cli/docs/SECURITY.md`.
  - @cordn/coordinator@0.5.5

## 0.5.7

### Patch Changes

- Absorb open-stream abort failures after session teardown and bump `@contextvm/sdk` to 0.14.1, which fixes the fatal `unhandledRejection` in the server-side `OpenStreamWriter` keepalive path (process exit 1, ~every 9h under load). The `stream.abort` override now logs a warning instead of letting the rejection escape when the transport already evicted the client session.

## 0.5.6

### Patch Changes

- Fix the Docker runtime image for the pnpm-workspace layout: install workspace member manifests before the frozen-lockfile install, produce the runtime node_modules with `pnpm deploy --filter=@cordn/server`, and declare `better-sqlite3` and `@scure/base` as server dependencies (the external-packages bundle imports them via inlined workspace code). Move `onlyBuiltDependencies` to `pnpm-workspace.yaml` so pnpm ≥10.17 actually builds the native sqlite binding again.

## 0.5.5

### Patch Changes

- Updated dependencies [7eb87bf]
  - @cordn/core@0.5.6
  - @cordn/coordinator@0.5.5

## 0.5.4

### Patch Changes

- 1c76cbb: Publish the CLI as the `cordn` npm executable with hosted coordinator defaults and bundled offline documentation. Add encrypted persistent state, non-interactive commands, and a daemon writer with file-based queues. Make queued Welcome identifiers unique and exact StoreWelcome retries idempotent for reusable last-resort KeyPackages.
- Updated dependencies [1c76cbb]
  - @cordn/coordinator@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies [cdfbced]
  - @cordn/core@0.5.4
  - @cordn/coordinator@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies
  - @cordn/core@0.5.2
  - @cordn/coordinator@0.5.2
