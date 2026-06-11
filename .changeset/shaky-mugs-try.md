---
"cordn": patch
---

feat(coordinator): add per-group cap for join requests

Removes group existence validation to allow join requests for newly
created groups without message history (bootstrap scenario). Adds a
per-group cap of 100 pending join requests to prevent unbounded
accumulation from fake group IDs while remaining generous enough for
real groups.