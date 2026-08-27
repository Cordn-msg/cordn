# Quickstart

## Install

```sh
npm install --global @cordn/cli
cordn --version
```

Node.js 20.12 or newer is required.

## Create a persistent client

```sh
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/cordn/session.json"
cordn --state-file "$STATE" --command status
```

On first use, Cordn generates a client identity and creates:

- `$STATE` — AES-256-GCM encrypted client snapshot
- `$STATE.key` — the 32-byte snapshot encryption key, encoded as hex

The bundled coordinator and relay defaults require no initial network flags. Override them when needed:

```sh
cordn \
  --server-pubkey <64-character-hex-public-key> \
  --relay wss://relay.example \
  --state-file "$STATE" \
  --command status
```

The selected coordinator and relays are saved in the snapshot, so subsequent commands only need `--state-file`.

## Inspect the public identity

`status` prints the stable public key without exposing the private key:

```sh
cordn --state-file "$STATE" --command status
```

`whoami` also prints the private identity key; do not run it in shared logs or untrusted agent contexts.

## Publish a KeyPackage

A regular KeyPackage is consumed by one invitation:

```sh
cordn --state-file "$STATE" --command "gen-kp main"
```

A last-resort KeyPackage can receive multiple invitations:

```sh
cordn --state-file "$STATE" --command "gen-kp reusable --last-resort"
```

## Create and use a group

```sh
cordn --state-file "$STATE" --command "create-group office"
cordn --state-file "$STATE" --command "groups"
cordn --state-file "$STATE" --command "send-to office hello"
cordn --state-file "$STATE" --command "messages office"
```

For an interactive session:

```sh
cordn --state-file "$STATE"
```

Inside the REPL:

```text
use office --watch
hello from the REPL
messages office
exit
```

## Accept an invitation

```sh
cordn --state-file "$STATE" --command "fetch-welcomes"
cordn --state-file "$STATE" --command "welcomes"
cordn --state-file "$STATE" \
  --command "accept-welcome <coordinator>:<kp_ref>:<at> office"
```

A newer re-invite refreshes the existing protocol group and retains its local alias and history.

## Next

- `cordn docs agent`
- `cordn docs daemon`
- `cordn docs queues`
- `cordn docs security`
