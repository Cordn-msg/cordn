---
"cordn": minor
---

feat(coordinator): add join request feature for group membership

Implement join request functionality allowing users to request to join groups
via shareable links. Includes storage implementations (in-memory and SQLite),
CLI commands (fetch-join-requests, request-join), server methods, and cleanup
timer extensions for automatic expiration. Also adds configurable max age for
unread welcomes and join requests via CORDN_UNREAD_MAX_AGE_DAYS environment
variable.