# Last-Resort Key Packages Implementation Plan

## Purpose

This document records the selected implementation plan for last-resort key packages in [`cordn`](package.json).

It is intentionally concise and focuses on the chosen direction for coordinator behavior, server tools, CLI behavior, storage changes, tests, and spec updates.

## Locked Decisions

### 1. Source of truth is the MLS KeyPackage extension

Last-resort status is derived from the published MLS [`KeyPackage.extensions`](ts-mls/src/keyPackage.ts:35), not from an out-of-band coordinator flag.

`cordn` will implement this using a local custom extension constant and helper utilities, without requiring upstream changes in [`ts-mls`](ts-mls/package.json).

The extension is the marker described in [`design/mls-extensions.txt`](design/mls-extensions.txt:1293) and is encoded as an empty-data KeyPackage extension.

### 2. Coordinator remains policy-light

The coordinator remains a storage and distribution service.

It should not enforce higher-level protocol policy such as:

- whether publishing last-resort key packages is wise
- how many regular or last-resort key packages a user should publish
- replay or stale-key tradeoff decisions

Those tradeoffs remain client and application concerns.

The coordinator only needs deterministic service behavior for publish, list, consume, and remove operations.

### 3. Last-resort behavior is derived, not trusted as input

When a key package is published, the server decodes it and derives whether it is last-resort by inspecting its extensions.

Any stored `isLastResort` field is internal derived metadata only.

The publish API does not gain a separate `isLastResort` input.

### 4. Consume semantics stay simple and predictable

The coordinator still needs deterministic retrieval behavior.

Selected rules:

- exact key package ref lookup returns that specific package
- exact ref lookup deletes the package only if it is not last-resort
- stable identity lookup returns the oldest non-last-resort package if one exists
- stable identity lookup falls back to the newest last-resort package
- returning a last-resort package does not delete it

This is service behavior, not protocol enforcement.

### 5. Removal is explicit and owner-controlled

The system will add a coordinator tool for removing published key packages.

The tool accepts an array of key package references for better operator and CLI UX.

Authorization is enforced in the server handler, not in coordinator internals.

Selected rule:

- the authenticated caller pubkey from request context must match the owner pubkey of every referenced stored key package
- if any referenced key package is not owned by the caller, the handler throws an authorization error
- if ownership checks pass, the handler removes the requested key packages

This keeps authorization at the transport boundary and coordinator internals straightforward.

## Implementation Plan

### 1. Add local last-resort helpers

Add a small local helper module in [`src/`](src/) that:

- defines the custom extension type constant used by `cordn`
- constructs the empty-data last-resort KeyPackage extension
- detects whether a [`KeyPackage`](ts-mls/src/keyPackage.ts:34) contains the extension
- validates that the extension data is empty

This module is local to `cordn` and does not modify [`ts-mls`](ts-mls/package.json).

### 2. Keep publish contract shape minimal

[`publishKeyPackageInputSchema`](src/contracts/index.ts:15) remains based on key package bytes and ref only.

No extra publish input flag is added for last-resort.

The server decodes the key package in [`CoordinatorToolAdapter.publishKeyPackage()`](src/server/coordinatorMethods.ts:96) and derives last-resort state from the KeyPackage extension.

### 3. Extend internal record metadata

[`PublishedKeyPackageRecord`](src/coordinator/types.ts:3) should gain derived metadata:

- `isLastResort: boolean`

This field is derived at publish time from the decoded KeyPackage and stored for efficient lookup and query behavior.

### 4. Add lookup and removal primitives

Add simple non-authorizing coordinator/storage operations:

- lookup published key package by ref
- remove published key package by ref

These methods should be mechanical only and should not perform caller ownership checks.

Recommended coordinator split:

- server layer handles authentication and authorization
- coordinator/storage layer handles record lookup and mutation

### 5. Update storage implementations

[`InMemoryCoordinatorStorage`](src/coordinator/storage/inMemoryStorage.ts:38)

- update key package storage shape so last-resort packages can be returned without deletion
- support lookup by ref
- support removal by ref
- preserve deterministic ordering for regular and fallback last-resort retrieval

[`SqliteCoordinatorStorage`](src/coordinator/storage/sqliteStorage.ts:61)

- add a derived `is_last_resort` column
- populate it when publishing a key package
- update queries so identity lookup prefers regular packages, then last-resort packages
- delete rows only for regular consume operations or explicit remove operations
- support batch remove by refs

No coordinator-side policy is added limiting the number of last-resort key packages per identity.

### 6. Add coordinator remove tool

Add a new coordinator tool in [`src/contracts/index.ts`](src/contracts/index.ts:3) and [`src/server/coordinatorMethods.ts`](src/server/coordinatorMethods.ts:226):

- name: `remove_key_packages`
- input: `keyPackageRefs: string[]`
- output: removed refs and/or removal count

Handler behavior:

1. read authenticated caller identity with [`requireClientPubkey()`](src/server/coordinatorMethods.ts:58)
2. resolve each referenced published key package
3. verify all referenced packages are owned by the caller
4. throw on any ownership mismatch
5. remove all authorized refs

This should behave atomically when possible, especially in SQLite-backed storage.

### 7. Simplify CLI generation flow

[`gen-kp`](src/cli/replCommands.ts:188) should generate and publish by default.

Selected CLI behavior:

- `gen-kp <alias>` → generate locally and publish
- `gen-kp <alias> --local-only` → generate locally only
- `gen-kp <alias> --last-resort` → generate a last-resort key package and publish it
- `gen-kp <alias> --last-resort --local-only` → generate a last-resort key package locally only

Implementation updates:

- evolve [`CliSession.generateKeyPackage()`](src/cli/session.ts:116) to accept options
- update [`createMemberArtifacts()`](src/cli/utils/mlsIdentity.ts:36) to optionally include the custom last-resort extension
- record derived `isLastResort` state in local [`StoredKeyPackage`](src/cli/sessionState.ts:20)
- Remove the `publish-kp` CLI command and related code

### 8. Simplify CLI deletion flow

[`delete-kp`](src/cli/replCommands.ts:188) should accept either a local alias or a raw key package ref.

Selected CLI behavior:

- `delete-kp <aliasOrKeyPackageRef>` → delete locally if present and also remove from coordinator
- `delete-kp <aliasOrKeyPackageRef> --local-only` → delete only from local session state

Implementation updates:

- resolve alias to [`StoredKeyPackage.keyPackageRef`](src/cli/sessionState.ts:24) when possible
- allow direct ref input for remote deletion
- add local removal helpers in [`CliSessionStore`](src/cli/sessionStore.ts:15)
- add session methods for combined local and remote deletion

### 9. Surface last-resort status in outputs

Even though publish input stays unchanged, coordinator outputs should expose derived last-resort status for clarity.

Update:

- [`availableKeyPackageSchema`](src/contracts/index.ts:40)
- [`consumedKeyPackageSchema`](src/contracts/index.ts:29)
- local CLI summaries in [`KeyPackageSummary`](src/cli/sessionState.ts:30)

This makes operator and test behavior explicit without making the server trust an out-of-band input flag.

### 10. Update tests

Coordinator and storage tests:

- add parity coverage in [`src/coordinator/storage/storage.test.ts`](src/coordinator/storage/storage.test.ts)
- update [`src/coordinator/coordinator.test.ts`](src/coordinator/coordinator.test.ts)
- cover derived last-resort detection, non-destructive fallback retrieval, and explicit removal

Server tests:

- update [`src/server/coordinatorServer.test.ts`](src/server/coordinatorServer.test.ts)
- cover batch remove authorization and error handling

CLI and integration tests:

- update [`src/cli/replCommands.test.ts`](src/cli/replCommands.test.ts)
- update [`src/cli/session.integration.test.ts`](src/cli/session.integration.test.ts)
- cover auto-publish generation, `--local-only`, last-resort generation, alias-or-ref deletion, and remote removal behavior

## Spec Updates

### 1. Update [`spec/00.md`](spec/00.md)

Add a subsection describing last-resort key packages.

Required points:

- a key package is considered last-resort when its KeyPackage extensions include the selected last-resort extension
- this status is part of the MLS object, not out-of-band coordinator input
- coordinators may derive service behavior from that extension
- stable identity lookup prefers regular key packages and falls back to last-resort key packages
- exact ref lookup of a last-resort key package is non-destructive
- coordinators may expose explicit key package removal operations

Also add brief removal semantics:

- published key packages may be explicitly removed by their owner
- owner authorization is enforced by authenticated caller identity at the server boundary

### 2. Update [`README.md`](README.md)

Add a short implementation note that:

- `cordn` supports last-resort key packages
- last-resort status is derived from the KeyPackage extension
- the CLI can generate and publish them
- published key packages can be explicitly removed

## Integration Order

Recommended implementation order:

1. add local last-resort helper module
2. extend coordinator types and storage internals
3. implement lookup/remove primitives
4. implement server-side batch remove tool and ownership checks
5. update publish/list/consume behavior for derived last-resort handling
6. update CLI generation and deletion UX
7. update tests
8. update [`spec/00.md`](spec/00.md) and [`README.md`](README.md)
