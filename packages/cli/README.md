# CLI

This directory contains the local [`cordn`](package.json) CLI client.

It is intended for:

- local development against a coordinator
- integration testing of group creation, invites, welcomes, sync, and messaging
- manual inspection of MLS-backed group behavior

## Entry points

- [`main.ts`](src/main.ts) — CLI startup
- [`repl.ts`](src/repl.ts) — interactive terminal interface
- [`session.ts`](src/session.ts) — in-memory client session model
- [`groupMetadata.ts`](src/groupMetadata.ts) — `cordn_group_metadata` encoding and decoding

## Usage

Start the CLI with:

```sh
pnpm run client:cli
```

Useful commands:

- `gen-kp [alias]`
- `key-packages` — inspect local key packages, including publish/consume state and metadata-extension support
- `publish-kp <alias>`
- `available-kps` — inspect coordinator-published key packages
- `create-group <alias> [keyPackageAlias] [--watch]`
- `create-group <alias> [keyPackageAlias] --name "Demo" --description "Shared group" --icon "🧵" --image-url "https://example.com/group.png"`
- `update-group-metadata <groupAlias> --name "Demo" [--description "Shared group"] [--icon "🧵"] [--image-url "https://example.com/group.png"] [--admin <hex>]...`
- `group <groupAlias> [--watch]`
- `accept-welcome <keyPackageReference> [groupAlias] [--watch]`
- `groups` — compact list of joined groups, shared metadata, and watch status
- `group-info [groupAlias]` — inspect one joined group's shared metadata and local state counters
- `watch-all` — start background subscriptions for all joined groups
- `unwatch <groupAlias>` — stop one background subscription
- `add-member <groupAlias> <stablePubkeyOrKeyPackageRef>`
- `fetch-welcomes`
- `fetch-join-requests <groupAlias>` — list pending join requests for a group
- `request-join <gid> [keyPackageAlias] [--coordinator <pubkey>]` — send a join request for a group
- `send <message...>`
- `send-media <filePath> [caption...]` — requires `--media-dir <dir>`
- `save-media [groupAlias] <cursor> [destDir]` — decrypts received media to `destDir` (default `.`)
- `sync [groupAlias]`

## Notes

- Group aliases are local convenience labels.
- Shared group presentation metadata is carried in MLS state through [`groupMetadata.ts`](src/groupMetadata.ts).
- Key packages advertise support for the shared metadata extension, but they do not contain a group's actual shared metadata values.
- Watching keeps a CEP-41 subscription alive in the background so watched groups stay locally synchronized without repeated bounded fetches.
- Live messages are rendered immediately when a watched group is currently selected in the REPL.
- This client is intentionally small and focused on development workflows rather than polished end-user UX.

## Encrypted media

The CLI can exchange encrypted media as defined in [`spec/applications/encrypted-media.md`](../../spec/applications/encrypted-media.md).

- Media is encrypted client-side with a key derived from the group's MLS exporter secret and stored as an opaque blob on a content-addressed `MediaStore`.
- The coordinator is unchanged; only an `imeta` tag travels inside the sealed group message.
- Pass `--media-dir <dir>` at startup to enable `send-media` / `save-media`. Two CLI processes on the same machine exchange media by pointing at the same directory (via [`FileMediaStore`](src/mediaStore.ts)). Blossom is the recommended production store.

## Reference client algorithm

The CLI is intended to act as a reference client for the core local sync logic.

- Every group tracks a monotonic local fetch cursor.
- Bounded catch-up still uses [`FetchGroupMessages()`](src/coordinatorClient.ts:331) or [`FetchManyGroupMessages()`](src/coordinatorClient.ts:342) as the canonical recovery API.
- Watch mode follows a strict `fetch first, then subscribe` flow matching [`design/group-message-stream-subscription-plan.md`](design/group-message-stream-subscription-plan.md:200).
- Clients watching many groups can replace multiple single-group subscribe calls with [`SubscribeManyGroupMessages()`](src/coordinatorClient.ts:371) after catch-up; streamed records keep the same shape and must still be ingested by `gid` with independent cursors.
- Fetched backlog and streamed live records are both treated as the same raw group-message input and are processed through one shared ingestion pipeline in [`ingestGroupMessages()`](src/groupSync.ts:31).
- Outbound self-echoes are reconciled by ciphertext identity instead of being MLS-processed again, so local send state is not corrupted by coordinator replay.
- Pending epoch operations such as add-member commits are only finalized after the corresponding inbound commit is observed and classified by the ingestion pipeline.
- Inbox records are retired explicitly rather than by observation. Accepting a welcome locally (or an admin resolving a fetched join request) queues a `consumed` ref that the next [`FetchPendingWelcomes()`](src/coordinatorClient.ts) / [`FetchPendingJoinRequests()`](src/coordinatorClient.ts) echoes back, so the coordinator retires the record. Records that are never acked fall to the max-age ceiling, never to a read timer.
