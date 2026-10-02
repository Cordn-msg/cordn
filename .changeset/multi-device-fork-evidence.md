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
