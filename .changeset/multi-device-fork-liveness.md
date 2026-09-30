---
"@cordn/cli": minor
---

feat(cli): equal-epoch fork tie-break + document identity tracking (spec §8/§10)

A symmetric sibling race leaves two same-epoch group documents that the
forward-only epoch rule could not rank, so both devices stayed forked with no
resolution; and a failed document fetch was not contractually distinguishable
from a completed reconcile.

- `applyDocumentEntry` / `reconcileGroupDocument` accept the document's
  content `address` and apply the spec §10 equal-epoch fork rule: rank =
  document cursor, then lexicographically greater content address; the losing
  device adopts the winner at the same epoch (the single forward-only
  exception, only ever moving up the rank order) and reports the new
  `"fork-resolved"` outcome.
- `GroupSessionState` records `appliedDocument` (address + publish cursor) on
  seed/fast-forward/fork-resolve and on `publishGroupDocument`, so a locally
  created group is rankable too.
- Integration coverage (spec §8 fetch liveness, spec §10 fork rule): a failed
  fetch leaves state untouched and a retry of the same address converges; an
  equal-epoch fork resolves deterministically on document rank, idempotently,
  and independent of application order.
