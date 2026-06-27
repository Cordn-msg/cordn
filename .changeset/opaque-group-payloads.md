---
"cordn": minor
---

feat(coordinator): deliver group messages as opaque sealed payloads

Coordinators now store and serve group message content as opaque bytes and no
longer parse, decode, or validate MLS message content. Payloads are sealed
end-to-end by clients with a per-epoch key derived from the MLS exporter
(`label: "cordn"`, `context: "group-payload"`, ChaCha20-Poly1305), so only
group members can read them. See `spec/03.md` for the full wire format and
interoperability requirements.

- Add an outer delivery group id (`gid`) to `postGroupMessage`; when supplied
  the coordinator skips MLS decoding and routes by `gid` directly. `gid` names
  the per-group delivery stream and cursor space, distinct from the MLS
  `group_id`.
- Add an `encrypted` flag to group message records.
- The coordinator no longer tracks MLS metadata for encrypted messages; the
  client-side encryption naturally filters out messages from epochs the client
  has not joined.
- Deprecate `since_epoch` filtering, the message `epoch`, and
  `ephemeralSenderPubkey`, retained for backward compatibility with legacy
  (unencrypted) clients during the transition.
