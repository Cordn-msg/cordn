---
"@cordn/cli": minor
---

feat(cli): fork resolution by evidence, descent check for newer-epoch documents (spec §8/§10)

- Fork detection compares epoch fingerprints (`epoch`, `treeHash`,
  `confirmedTranscriptHash`), not content addresses: a re-publish of the
  same state is advisory, never a fork.
- Resolution follows the §10 procedure: coordinator order first (each
  Commit records, right after posting, whether a competing Commit from the
  shared leaf preceded it — `branch` live/dead), then a third-party verdict
  (messages past the cursor tried under both branches; one from another
  leaf that opens under exactly one branch decides), then the document rank
  as the fallback. Decisions are recorded per epoch and not overturned by
  the rank alone; every fork is surfaced as a sync issue.
- A newer-epoch document is checked for descent when its `prev` chain can
  be read (`reconcileGroupDocument(..., chain)`): a chain that meets a state
  this device held at an earlier epoch, but not its current one, is a fork
  that has moved on and goes through the same procedure instead of a plain
  fast-forward.
