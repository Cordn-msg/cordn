# CLI

This directory contains the local [`cordn`](package.json) CLI client.

It is intended for:

- local development against a coordinator
- integration testing of group creation, invites, welcomes, sync, and messaging
- manual inspection of MLS-backed group behavior

## Entry points

- [`main.ts`](src/cli/main.ts) — CLI startup
- [`repl.ts`](src/cli/repl.ts) — interactive terminal interface
- [`session.ts`](src/cli/session.ts) — in-memory client session model
- [`groupMetadata.ts`](src/cli/groupMetadata.ts) — `cordn_group_metadata` encoding and decoding

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
- `create-group <alias> [keyPackageAlias]`
- `create-group <alias> [keyPackageAlias] --name "Demo" --description "Shared group" --icon "🧵" --image-url "https://example.com/group.png"`
- `groups` — compact list of joined groups and shared metadata
- `group-info [groupAlias]` — inspect one joined group's shared metadata and local state counters
- `add-member <groupAlias> <stablePubkeyOrKeyPackageRef>`
- `fetch-welcomes`
- `accept-welcome <keyPackageReference> [groupAlias]`
- `send <message...>`
- `sync [groupAlias]`

## Notes

- Group aliases are local convenience labels.
- Shared group presentation metadata is carried in MLS state through [`groupMetadata.ts`](src/cli/groupMetadata.ts).
- Key packages advertise support for the shared metadata extension, but they do not contain a group's actual shared metadata values.
- This client is intentionally small and focused on development workflows rather than polished end-user UX.
