# @cordn/cli

Persistent MLS client for [Cordn](https://github.com/Cordn-msg/cordn). It supports an interactive REPL, one-shot commands, encrypted restart-safe state, live group watches, and durable filesystem queues for local agents and automations.

## Install

```sh
npm install --global @cordn/cli
cordn --version
cordn --help
```

Node.js 20.12 or newer is required.

## Bundled documentation

The package includes version-matched offline documentation. These commands do not require state, network access, or coordinator configuration:

```sh
cordn docs
cordn docs quickstart
cordn docs agent
cordn docs daemon
cordn docs queues
cordn docs security
```

## Hosted default

A fresh client uses:

```text
coordinator: 92753cbe63e943d0c4a0c61d745437892af6e98f179ce04a7a863aad4e00b1a5
relays:
  wss://relay.contextvm.org
  wss://relay2.contextvm.org
  wss://relay.primal.net
```

Override these with `--server-pubkey` and one or more `--relay` options. Persistent snapshots remember the coordinator and relays used to create them. Local development can continue deriving the coordinator public key from `CORDN_SERVER_PRIVATE_KEY` and reading comma-separated `CORDN_RELAY_URLS`.

## Quickstart

```sh
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/cordn/session.json"

cordn --state-file "$STATE" --command status
cordn --state-file "$STATE" --command "gen-kp main"
cordn --state-file "$STATE" --command "create-group office"
cordn --state-file "$STATE" --command "send-to office hello"
cordn --state-file "$STATE" --command "messages office"
```

The first command generates a client identity and creates:

- `$STATE` — AES-256-GCM encrypted identity, MLS state, cursors, and history
- `$STATE.key` — the hex-encoded 32-byte snapshot encryption key

Back up both files securely. Only one process may use a snapshot at a time.

## Interactive mode

```sh
cordn --state-file "$STATE"
```

Useful commands include:

```text
status
whoami
gen-kp [alias] [--last-resort] [--local-only]
key-packages
available-kps
create-group <alias> [keyPackageAlias] [--watch]
groups
group-info [groupAlias]
use <groupAlias> [--watch]
add-member <groupAlias> <stablePubkeyOrKeyPackageRef>
remove-member <groupAlias> <stablePubkey>
fetch-welcomes
welcomes
accept-welcome <welcomeIdOrKeyPackageReference> [groupAlias] [--watch]
send <message...>
send-to <groupAlias> <message...>
sync [groupAlias]
sync-all
watch-all
messages [groupAlias]
issues [groupAlias]
```

After selecting a group with `use`, plain text sends a message and an empty line synchronizes it. `whoami` prints the private identity key; prefer `status` unless explicit export is intended.

## One-shot mode

```sh
cordn --state-file "$STATE" --command "groups"
cordn --state-file "$STATE" --command "sync office"
cordn --state-file "$STATE" --command "send-to office hello"
```

Use `send-to` rather than `send`: selected-group context does not survive between processes.

## Persistent daemon

Bootstrap the identity and publish a KeyPackage before starting a long-running agent:

```sh
ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/cordn/agent"
mkdir -p "$ROOT/inbox" "$ROOT/outbox"
chmod 700 "$ROOT" "$ROOT/inbox" "$ROOT/outbox"

cordn \
  --state-file "$ROOT/session.json" \
  --daemon \
  --group-alias office \
  --outbox-dir "$ROOT/outbox" \
  --inbox-dir "$ROOT/inbox"
```

The daemon fetches matching Welcomes, accepts them using local KeyPackage material, catches groups up before watching, writes decrypted inbound messages to the inbox, and processes ordered JSON outbox jobs. It must be the sole writer of its snapshot.

Both queue directions are at-least-once. Producers must write a non-`.json` temporary file and atomically rename it into the outbox. Consumers must claim inbox records and deduplicate by `groupAlias + cursor + id`.

Run `cordn docs queues` for exact schemas and crash behavior.

## Encrypted media

Pass `--media-dir <path>` to enable `send-media` and `save-media`. Media is encrypted client-side using an MLS exporter-derived key and stored as an opaque content-addressed blob. Multiple local clients must share the same media directory for filesystem-backed exchange; a network content store is required across hosts.

See the [encrypted-media specification](https://github.com/Cordn-msg/cordn/blob/master/spec/applications/encrypted-media.md).

## Development from the monorepo

```sh
pnpm install
pnpm run client:cli -- --state-file /tmp/cordn-session.json
pnpm --filter @cordn/cli run build
pnpm --filter @cordn/cli run pack:check
```

The reference sync implementation follows fetch-first-then-subscribe semantics, independent per-group cursors, one inbound ingestion path for catch-up and live records, ciphertext-based self-echo reconciliation, and inbound confirmation before pending epoch operations are finalized.

## License

MIT
