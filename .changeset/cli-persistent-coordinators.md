---
"@cordn/cli": minor
---

`openPersistentSession` accepts `coordinators` (keyed by server pubkey, each with its own relays or relay handler), passed through to `CliSession`, so library callers can reach groups on more than one coordinator without touching session internals. Like `transportEncryption`, it is not saved in the snapshot.
