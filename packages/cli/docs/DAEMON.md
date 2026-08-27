# Daemon mode

The daemon is a foreground, long-running Cordn client. A service manager, container runtime, or terminal multiplexer is responsible for supervision.

## Start

```sh
ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/cordn/agent"
mkdir -p "$ROOT/inbox" "$ROOT/outbox"
chmod 700 "$ROOT" "$ROOT/inbox" "$ROOT/outbox"

cordn \
  --state-file "$ROOT/session.json" \
  --daemon \
  --group-alias office \
  --inbox-dir "$ROOT/inbox" \
  --outbox-dir "$ROOT/outbox"
```

`--state-file` is required. Inbox and outbox directories must be distinct, and state/key JSON files cannot be placed inside either queue.

## Cycle

Approximately every five seconds the daemon:

1. fetches pending Welcomes from the default coordinator
2. accepts records matching locally held KeyPackage material
3. persists each accepted group state
4. starts or repairs watches for every active group
5. processes outbox jobs in lexical filename order

Group watches first perform bounded catch-up and then subscribe to live delivery. Once connected, inbound messages do not wait for the five-second polling interval.

A regular KeyPackage is consumed by its first accepted invitation. A last-resort KeyPackage remains eligible for later invitations.

`--group-alias` is both the base alias for newly accepted groups and the default group for outbox jobs that omit `groupAlias`. Additional groups receive numeric suffixes such as `office-2`. A newer re-invite to an existing protocol group retains its existing alias.

## State ownership

The daemon exclusively locks:

```text
<state-file>.lock
```

A second process using the snapshot fails rather than risking an MLS-state fork. If a process crashes, the next startup removes the lock only when its recorded PID is no longer running.

All inbox and snapshot writes are serialized. An inbound inbox file becomes durable before the corresponding cursor is persisted, preventing permanent notification loss. Duplicate inbox records remain possible after a crash.

## Shutdown

Send `SIGINT` or `SIGTERM` for graceful shutdown. The daemon:

1. leaves the polling loop
2. disconnects live watches
3. waits for queued inbox/state writes
4. persists a final encrypted snapshot
5. removes the state lock

Shutdown can take roughly one polling interval. Use `SIGKILL` only when graceful shutdown cannot complete; queued `.processing` files and stale state locks are recovered on restart.

## Failures

- Welcome-fetch errors are logged; existing watches and outbox work continue.
- One malformed or unprocessable Welcome does not stop other Welcomes.
- Errored watches are retried in later cycles.
- Invalid outbox JSON is quarantined as `.json.invalid`.
- Send failures return the job to `.json` and retry it later.
- A durability failure stops the daemon with nonzero status rather than advancing volatile MLS state.

A valid job that fails permanently, such as one naming an unknown group, remains at the front of the ordered outbox and can delay later jobs. Operators should monitor daemon stderr and `.invalid`/`.processing` files.

See `cordn docs queues` for the mailbox contract and `cordn docs security` for deployment guidance.
