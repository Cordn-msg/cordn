# @cordn/cli

## 0.7.0

### Minor Changes

- c8f85c0: Expose the Node client as an importable library: `import { CliSession, openPersistentSession, ... } from "@cordn/cli"`, with typed `dist/lib/**` output published alongside the `cordn` executable. The daemon's persistent-session wiring (state lock, snapshot restore, serialized durable writes) moved into `openPersistentSession` and is shared by the CLI.

## 0.6.2

### Patch Changes

- 7eb87bf: Upgrade `@contextvm/sdk` to 0.13.17 across all workspace packages and unify zod at 4.6.5 so a single `@contextvm/mcp-sdk` instance is resolved (fixes `Client` type mismatch between the SDK transport and the CLI's MCP client).
- Updated dependencies [7eb87bf]
  - @cordn/core@0.5.6

## 0.6.1

### Patch Changes

- d5bf583: Exit the interactive REPL cleanly on Ctrl+C, add the missing `publish-kp` command, fix option parsing for join requests, and keep command detection, help output, and bundled command documentation consistent from one catalog.

## 0.6.0

### Minor Changes

- 1c76cbb: Publish the CLI as the `cordn` npm executable with hosted coordinator defaults and bundled offline documentation. Add encrypted persistent state, non-interactive commands, and a daemon writer with file-based queues. Make queued Welcome identifiers unique and exact StoreWelcome retries idempotent for reusable last-resort KeyPackages.

## 0.5.3

### Patch Changes

- Updated dependencies [cdfbced]
  - @cordn/core@0.5.4

## 0.5.2

### Patch Changes

- Updated dependencies
  - @cordn/core@0.5.2
