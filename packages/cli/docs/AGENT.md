# Agent usage

Use the CLI directly for bounded operations and its filesystem queues for a continuously running integration.

## Discover the installed interface

```sh
cordn --version
cordn --help
cordn docs
cordn docs queues
```

Do not assume flags from a different installed version. These bundled documents are the local source of truth.

## Bootstrap safely

Choose paths outside source repositories and restrict their parent directory:

```sh
ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/cordn/agent"
mkdir -p "$ROOT"
chmod 700 "$ROOT"

cordn --state-file "$ROOT/session.json" --command status
```

The default hosted coordinator is ready without additional flags. Use explicit `--server-pubkey` and `--relay` options only when targeting another deployment.

Back up both `session.json` and `session.json.key`. Never print, transmit, or edit either file.

## One-shot operations

When no daemon owns the state:

```sh
cordn --state-file "$ROOT/session.json" --command "groups"
cordn --state-file "$ROOT/session.json" --command "sync office"
cordn --state-file "$ROOT/session.json" --command "messages office"
cordn --state-file "$ROOT/session.json" --command "send-to office hello"
```

Use `send-to`; selected REPL group context does not persist between processes. Treat nonzero exit status as failure.

Avoid `whoami` in agent workflows because it includes the private identity key. `status` exposes only the stable public key and local counts.

## Invitations

Before waiting for an invitation, publish a KeyPackage:

```sh
# One invitation
cordn --state-file "$ROOT/session.json" --command "gen-kp agent-main"

# Reusable across invitations
cordn --state-file "$ROOT/session.json" \
  --command "gen-kp agent-reusable --last-resort"
```

A long-running daemon automatically accepts matching Welcomes for locally held KeyPackages. It ignores Welcomes for which private KeyPackage material is unavailable.

## Continuous operation

```sh
mkdir -p "$ROOT/inbox" "$ROOT/outbox"
chmod 700 "$ROOT/inbox" "$ROOT/outbox"

cordn \
  --state-file "$ROOT/session.json" \
  --daemon \
  --group-alias office \
  --inbox-dir "$ROOT/inbox" \
  --outbox-dir "$ROOT/outbox"
```

The daemon is the sole MLS-state writer. Do not run another `cordn` process against the same snapshot while it is active. Send through the outbox instead, or gracefully stop the daemon before running a one-shot command.

Use a service manager for restart policy. `SIGINT` and `SIGTERM` trigger final persistence and lock release.

## Agent loop

1. Atomically claim an inbox `.json` file by renaming it to a non-`.json` name.
2. Validate its fields and authorize `groupAlias` and `sender`.
3. Deduplicate by `groupAlias + cursor + id`.
4. Produce a text response.
5. Write the outbox payload to a temporary file in the outbox directory.
6. Flush it and atomically rename it to a unique `.json` filename.
7. Persist the consumer's deduplication record before deleting its claimed inbox file.

Inbox and outbox delivery are at-least-once. A crash can produce duplicate work or duplicate messages; consumers must be idempotent.

See `cordn docs queues` for exact schemas and shell examples.

## Trust boundary

Cordn decrypts messages before placing plaintext in the inbox. Sending that plaintext to an AI provider changes the privacy boundary: the provider can see it. Use an explicit bot identity, disclose the provider to group members, authorize senders, limit input size and rate, and disable agent tools unless separately sandboxed and approved.
