# @cordn/server

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
