# @cordn/cli

## 0.10.0

### Minor Changes

- 5130632: feat(cli): fork resolution by evidence, descent check for newer-epoch documents (spec §8/§10)
  - Fork detection compares epoch fingerprints (`epoch`, `treeHash`,
    `confirmedTranscriptHash`), not content addresses: a re-publish of the
    same state is advisory, never a fork.
  - Resolution follows the §10 procedure: coordinator order first (each
    Commit records, right after posting, whether a competing Commit from the
    shared leaf preceded it — `branch` live/dead), then a third-party verdict
    (messages past the cursor tried under both branches; one from another
    leaf that opens under exactly one branch decides), then the rank as the
    fallback — by where each branch's Commit landed, read off the `prev`
    chains (lowest document cursor at the fork epoch, lower wins), with the
    live-document rank only where a side has no document there or the chains
    cannot be read. Decisions are recorded per epoch and not overturned by
    the rank alone; every fork is surfaced as a sync issue.
  - `publishGroupDocument` chains the epoch's commit-point document (the
    state right after this device's own Commit, at the Commit's cursor) under
    the live one whenever the live state has moved past it, once per epoch —
    spec §8.5 gen-0 state for a sibling's catch-up, and the branch's Commit
    cursor for the rank.
  - A newer-epoch document is checked for descent when its `prev` chain can
    be read (`reconcileGroupDocument(..., chain)`): a chain that meets a state
    this device held at an earlier epoch, but not its current one, is a fork
    that has moved on and goes through the same procedure instead of a plain
    fast-forward.

- 5181208: feat(cli): fetch-liveness contract and document identity tracking (spec §8/§10)

  A failed document fetch was not contractually distinguishable from a
  completed reconcile, so a caller could record a `gid` as reconciled after a
  failed pull and never retry it.
  - `applyDocumentEntry` / `reconcileGroupDocument` accept the document's
    content `address` and report the `"fork-resolved"` outcome; a failed fetch
    leaves local state untouched and a retry of the same address converges
    (spec §8 fetch liveness — a failed pull is never a completed reconcile).
  - `GroupSessionState` records `appliedDocument` (address, publish cursor,
    state fingerprint) on seed/fast-forward/fork-resolve and on
    `publishGroupDocument`, so a locally created group is rankable too.

  The fork rule itself (fingerprint detection, evidence-first resolution,
  commit-point rank, descent check) is described in
  `multi-device-fork-evidence`.

- dafbecf: feat(cli): multi-device relay hints + last-resort publish markers (spec §4.1/§4.2/§9)

  The group document's `coordinator` named who serves `gid` but not where to
  reach them, so a device seeding a self-hosted coordinator fell back to
  session-default relays and the delivery stream never opened.
  - `GroupDocument` gains the OPTIONAL `coordinatorRelays` hint (locator-only,
    group-ref §4.3 semantics). `publishGroupDocument` populates it from the
    session's registered relay configuration for that coordinator.
  - Seeding and fast-forwarding adopt hints fill-if-empty: a device with no
    relay configuration of its own for the coordinator records them as its
    connection relays; locally configured relays or a relay handler always win
    (spec §9).
  - `LastResortKeyPackageEntry` gains the OPTIONAL `coordinators` list (spec
    §4.2): the per-coordinator publish markers recorded at
    `publishKeyPackage`, carried in the meta document, and restored on a
    linked device (spec §11.5).

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
