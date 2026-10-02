---
"@cordn/cli": minor
---

feat(cli): fetch-liveness contract and document identity tracking (spec §8/§10)

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
