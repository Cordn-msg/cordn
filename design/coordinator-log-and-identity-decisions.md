# Coordinator Log and Message Identity Decisions

## Purpose

This document records the design decisions currently locked for the coordinator log model, message identity model, and fetch semantics.

It intentionally focuses on the selected direction and keeps discarded alternatives brief.

## Locked Decisions

### 1. Coordinators remain uniform

All coordinators implement the same protocol surface.

The system does not introduce different protocol roles such as special write coordinators versus replica-only coordinators.

At any given moment, a group may use one coordinator as its active write target, but that is an operational choice, not a different coordinator type.

### 2. Message ordering uses per-group cursors

Each coordinator maintains a monotonic cursor **per group**.

Properties:

- cursor values are scoped to one group
- cursors define fetch progression and message order within that group on that coordinator
- cursors are pagination and ordering primitives, not canonical message identities
- cursors are simpler and more privacy-preserving than one global coordinator-wide cursor

### 3. Message identity uses a stable content-derived id

Each stored MLS message has a stable canonical identifier derived from the serialized opaque MLS message bytes.

Recommended form:

- `messageId = SHA256(opaqueMessageBytes)`

Properties:

- stable across export, import, replication, and migration
- suitable for deduplication and reconciliation
- independent from coordinator-local cursor assignment

### 4. Public fetch progression uses per-group `afterCursor`

The fetch interface remains cursor-based.

Properties:

- `afterCursor` is scoped to a specific group
- clients fetch ordered messages after that group cursor

### 5. Stable ids remain necessary even with per-group cursors

Per-group cursors solve ordered incremental fetching.

Stable ids are still required for:

- deduplication
And future use cases: 
- future mirror reconciliation
- migration correctness
- diagnostics and operator tooling

### 6. Group metadata belongs in MLS extensions

Group metadata should live in MLS-authenticated extension data, not only in coordinator-local state.

The initial extension should stay minimal and only include fields with immediate product value.

Recommended initial direction:

- group display name
- optional description