# @cordn/cli

## 0.8.0

### Minor Changes

- d2a63e1: `openPersistentSession` accepts `coordinators` (keyed by server pubkey, each with its own relays or relay handler), passed through to `CliSession`, so library callers can reach groups on more than one coordinator without touching session internals. Like `transportEncryption`, it is not saved in the snapshot.
- 78a86a2: Add opt-in transport encryption for coordinator requests: `--transport-encryption required` (or `CORDN_TRANSPORT_ENCRYPTION=required`) on the CLI, and `transportEncryption: "required"` on `openPersistentSession`, `CliSession` and `cordnClient`. Requests are then sent as NIP-59 gift wraps (ephemeral kind 21059) instead of plaintext ContextVM events, so relays no longer see the method, group id, cursors or timing. The default remains `disabled`. Requests are de-duplicated by event id in both modes since `@contextvm/sdk` 0.14.2.

### Patch Changes

- 30c4d34: Document the programmatic (library) integration path in `cordn docs agent`: `openPersistentSession` embedding for Node agent harnesses, with lock/durability semantics, alongside the existing filesystem-queue flow.
- 11f3b58: Bump `@contextvm/sdk` to 0.14.2 across cli, server and test-utils. The transport now de-duplicates plaintext requests by event id as well: a request carried by N relays is processed (and stored) once in both transport modes, fixing the duplicate-cursor "generation in the past" failures for the default `disabled` mode. Same-second byte-identical repeats are dropped by design (no nonce); recovery is caller-driven — see `packages/cli/docs/SECURITY.md`.

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
