---
"@cordn/core": minor
---

feat(core): one group-metadata codec and one normalization for every client

The group metadata extension codec (spec/01.md §4) and its
coordinator_routing trailing field move here from @cordn/cli and cordn-web's
private copy, so the wire forms and normalization cannot drift apart again.
Includes the trailing-field tolerance rule (spec/01.md §4),
normalizePubkey/safeNormalizePubkey, the pure admin-policy helpers, and the
coordinator-handoff §4.4/§14 routing-void predicate.

Unified behaviors (were divergent copies): admin duplicates are rejected on
encode after normalization and deduped on decode (a hostile Commit must not
abort ingestion); a blank admin entry is rejected, never silently
egalitarian; metadata capabilities now also advertise the app-data
dictionary extension; the codec is browser-safe (no Buffer).
