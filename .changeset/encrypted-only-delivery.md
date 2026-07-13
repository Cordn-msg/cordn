---
"cordn": minor
---

feat(coordinator)!: commit to the encrypted-only delivery path and drop the legacy wire surface

The staged rollout of payload encryption is complete. The coordinator treats
every `postGroupMessage` payload as opaque bytes routed by a caller-supplied
`gid`, and never decodes MLS. With the rollout done, the legacy unencrypted
path, the staged-rollout toggle, the single-group wire methods, and the
server-side epoch filtering are removed outright (not deprecated).

### Removed / renamed (BREAKING)

- **`postGroupMessage` (`msg_post`)**: `gid` is now **required**. The
  coordinator routes purely by the supplied `gid`; it no longer decodes the MLS
  payload to derive the group id, validate it, or reject stale handshakes. The
  `groupId` field on `PostGroupMessageInput` is required.
- **No server-side MLS validation.** The coordinator stores any bytes opaquely
  under the supplied `gid`; it no longer rejects malformed/non-MLS payloads.
  Clients that relied on the server erroring on bad input must validate first.
- **Single-group wire methods removed**: `msg_fetch`, `msg_sub`,
  `join_request_take`, plus their input/output schemas, types, client wrappers
  (`FetchGroupMessages` / `SubscribeGroupMessages` / `FetchPendingJoinRequests`),
  and adapter delegates. Use the `*_many` variants with a single-element
  `groups` array. (The coordinator/storage-level single methods remain as
  internal building blocks.)
- **`since_epoch` removed** end-to-end: the wire field, the `sinceEpoch` input,
  `parseSinceEpoch`, and the in-memory + SQLite filters. It was a no-op once
  every message carried epoch `0n`; clients filter epochs via decryption.
- **Storage columns/fields removed**: the `epoch` and `encrypted` columns on
  `group_messages`, the `latest_handshake_epoch` column on `group_routing`, and
  the matching `GroupMessageRecord.epoch`/`encrypted`,
  `GroupRoutingRecord.latestHandshakeEpoch`, and `AppendGroupMessageParams`
  fields. New SQLite databases omit these columns; existing databases keep them
  harmlessly ignored (INSERT/SELECT no longer reference them) — same pattern the
  0.3.0 release used for the old `read_at` columns.
- **`encryptOutbound` CliSession option removed.** Outbound payloads are always
  exporter-encrypted and the read path always decrypts; the mixed-version
  (legacy reader) interop window is closed.

### Migration notes

- Existing coordinator databases may still hold legacy rows (`encrypted = 0`).
  Upgraded clients always decrypt on read, so such rows fail decryption and are
  skipped — legacy rows become unreadable. Back up / migrate a coordinator with
  legacy data that must remain readable before deploying.
- The wire output no longer includes `encrypted` on group messages. Clients
  reading that field must stop; all delivered messages are encrypted.

### Internal (not part of the wire contract)

- `FetchGroupMessagesInput` lost its `sinceEpoch` field. The single
  `fetchGroupMessages` / `subscribeGroupMessages` / `fetchPendingJoinRequests`
  coordinator + storage methods are retained as internal building blocks (still
  used by tests and the Many variants' internals).
