---
"@cordn/cli": patch
---

Bump `@contextvm/sdk` to 0.14.2, which de-duplicates plaintext requests by event id as well: a request carried by N relays is now processed (and stored) once in both transport modes, fixing the duplicate-cursor "generation in the past" failures for the default `disabled` mode.
