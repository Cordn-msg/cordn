---
"cordn": minor
---

feat(coordinator)!: simplify inbox lifecycle with a max-age ceiling and explicit consumed acks

Replace the separate read/unread TTLs for welcomes and join requests with a
single global max-age ceiling (`CORDN_MAX_AGE_DAYS`) plus an optional
`consumed` parameter on the inbox fetch methods.

Inbox records are now deleted only when the caller explicitly acknowledges
consumption, or when their age exceeds the max-age ceiling. Fetching no longer
deletes records, so the owner explicitly retires their own key packages and
join requests.

- Add `consumed` to `fetchPendingWelcomes` (keyed by `kp_ref` + `at`),
  `fetchPendingJoinRequests`, and `fetchManyPendingJoinRequests` (keyed by
  `pk` + `at`, plus `gid` for the multi-group variant) to remove the referenced
  consumed records on fetch.
- Remove the `readAt` tracking fields and read-based deletion from welcome and
  join-request records; remove the `CORDN_UNREAD_MAX_AGE_DAYS` /
  `CORDN_WELCOME_TTL_MS` style read/unread TTL knobs in favor of
  `CORDN_MAX_AGE_DAYS`.

BREAKING CHANGE: the welcome/join-request `readAt` field and read/unread TTL
configuration are removed; callers must pass `consumed` refs to retire records.
