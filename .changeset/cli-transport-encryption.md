---
"@cordn/cli": minor
---

Add opt-in transport encryption for coordinator requests: `--transport-encryption required` (or `CORDN_TRANSPORT_ENCRYPTION=required`) on the CLI, and `transportEncryption: "required"` on `openPersistentSession`, `CliSession` and `cordnClient`. Requests are then sent as NIP-59 gift wraps (ephemeral kind 21059) instead of plaintext ContextVM events, so relays no longer see the method, group id or cursors, and a request carried by several relays is de-duplicated by the transport instead of being stored once per relay. The default remains `disabled`.
