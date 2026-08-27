# Filesystem queue contract

The queues provide local inter-process communication while the daemon exclusively owns MLS state.

Use dedicated inbox and outbox directories on the same host. Producers must create temporary and final files in the same directory so rename is atomic.

## Outbox: application to Cordn

The daemon processes files ending in `.json` in lexical filename order.

### Payload

```json
{
  "groupAlias": "office",
  "message": "hello"
}
```

- `message` is required, must be a nonempty string, and is sent without trimming.
- `groupAlias` must be a string when present.
- `groupAlias` may be omitted when daemon startup supplied `--group-alias`.
- Additional fields are currently ignored.

### Atomic producer

```sh
OUTBOX=/path/to/outbox
id="$(date +%s%N)"
temporary="$OUTBOX/$id.tmp"
final="$OUTBOX/$id.json"

jq -cn \
  --arg groupAlias office \
  --arg message 'hello' \
  '{groupAlias: $groupAlias, message: $message}' > "$temporary"
chmod 600 "$temporary"
sync -f "$temporary"
mv "$temporary" "$final"
```

Never stream content directly into a `.json` filename. The rename into `.json` commits the job.

Timestamp-prefixed names are a convenient ordering convention, but every producer must ensure filenames are unique.

### Daemon lifecycle

```text
job.json
  → job.json.processing
  → send to coordinator
  → persist updated MLS state
  → delete job.json.processing
```

Malformed JSON or invalid fields produce:

```text
job.json.invalid
```

The daemon continues with later jobs after quarantining malformed input.

A send or persistence failure returns `.processing` to `.json` and stops that processing pass. A `.json.processing` file left by a crash is adopted on the next pass.

The daemon logs successful acceptance as:

```text
outbox sent <filename> cursor=<cursor>
```

File deletion means the coordinator accepted the message and the updated local MLS state was persisted. It does not prove every peer has already received it.

## Inbox: Cordn to application

The daemon writes one atomic `.json` file for every newly decrypted inbound message.

### Payload

```json
{
  "groupAlias": "office",
  "cursor": 12,
  "createdAt": 1730000000000,
  "sender": "64-character-stable-public-key",
  "id": "nostr-event-id",
  "content": "hello"
}
```

Current inbox records are text-oriented and omit event tags and media metadata. Outbound self-echoes are reconciled internally and are not emitted as inbound jobs.

Filenames have this shape:

```text
0000000000000012-<uuid>.json
```

The padded cursor provides useful lexical order within a group. Cursors are independent per group; the directory is not one global cross-group timeline.

The daemon writes and flushes `<name>.json.tmp`, atomically renames it to `<name>.json`, syncs the inbox directory, and then persists the updated session cursor.

### Consumer

Atomically claim each file before processing:

```sh
INBOX=/path/to/inbox

for file in "$INBOX"/*.json; do
  [ -e "$file" ] || continue
  claimed="$file.claimed.$$"
  mv "$file" "$claimed" || continue

  # Validate and authorize the JSON.
  # Persist deduplication and application effects.

  rm "$claimed"
done
```

The consumer owns recovery for its `.claimed.*` files. The Cordn daemon never removes inbox records.

Deduplicate with the tuple:

```text
groupAlias + cursor + id
```

Authorize both the local group and stable sender before passing plaintext to an automation or model.

## Delivery guarantee

Both directions are at-least-once.

Outbox duplication can occur if the coordinator accepts a message but the process crashes before deleting its job. Inbox duplication can occur if the inbox file becomes durable but the process crashes before persisting its cursor.

Exactly-once application behavior requires an application-level idempotency key and durable deduplication journal.

## Permissions and placement

- Create queue directories with mode `0700`.
- Create files with mode `0600`.
- Keep inbox and outbox separate.
- Never place the encrypted state or state-key file inside a queue.
- Do not let untrusted users write jobs into the outbox.
- Do not expose decrypted inbox files beyond the intended consumer.
