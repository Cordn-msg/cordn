---
"@cordn/cli": patch
"@cordn/server": patch
"@cordn/test-utils": patch
---

Bump `@contextvm/sdk` to 0.14.2 across cli, server and test-utils. The transport now de-duplicates plaintext requests by event id as well: a request carried by N relays is processed (and stored) once in both transport modes, fixing the duplicate-cursor "generation in the past" failures for the default `disabled` mode. Same-second byte-identical repeats are dropped by design (no nonce); recovery is caller-driven — see `packages/cli/docs/SECURITY.md`.
