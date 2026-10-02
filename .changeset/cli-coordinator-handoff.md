---
"@cordn/cli": minor
---

feat(cli): coordinator handoff reference client (spec/applications/coordinator-handoff.md)

Preferred coordinator + fallback roster as group metadata (declared at birth
or by admin metadata edits), roster-gated switching with planned and failover
semantics, prevention-first failover, counted history with per-stream cursors
and soft gaps, prev-linked envelopes with send-window siblings, and the
§4.4/§14 void of routing updates that move `active` outside the declared
fallbacks — enforced at every metadata adoption and surfaced as a sync
issue. REPL: switch-coordinator, discover-coordinator, resend.
