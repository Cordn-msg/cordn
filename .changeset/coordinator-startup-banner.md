---
"cordn": minor
---

feat(server): visual startup banner with nprofile and cordn.net setup URL

The coordinator server now prints a multi-line banner to stdout at startup
instead of a single JSON splash line, making it easier to visually identify a
running server and copy its connection details.

- Show the hex `pubkey` alongside an `nprofile` (NIP-19 encoding of the pubkey
  plus the configured relays as hints), so clients can target the server by a
  single self-contained identifier.
- Print a `https://cordn.net/chat/coordinators?c=<nprofile>` URL that adds
  this coordinator automatically when opened, lowering the setup cost for new
  users.
- The banner is written to `stdout` (not pino) so line breaks and symbols
  render for operators instead of being JSON-escaped. The structured
  `serverPubkey` is still emitted in the later "connected" JSON log line, so
  machine consumers lose nothing.
