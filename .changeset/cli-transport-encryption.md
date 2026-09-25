---
"@cordn/cli": minor
---

Add opt-in transport encryption for coordinator requests: `--transport-encryption required` (or `CORDN_TRANSPORT_ENCRYPTION=required`) on the CLI, and `transportEncryption: "required"` on `openPersistentSession`, `CliSession` and `cordnClient`. Requests are then sent as NIP-59 gift wraps (ephemeral kind 21059) instead of plaintext ContextVM events, so relays no longer see the method, group id, cursors or timing. The default remains `disabled`. Requests are de-duplicated by event id in both modes since `@contextvm/sdk` 0.14.2.
