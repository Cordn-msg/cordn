# Security

## Hosted default

Without explicit configuration, the CLI uses:

```text
coordinator: 92753cbe63e943d0c4a0c61d745437892af6e98f179ce04a7a863aad4e00b1a5
relays:
  wss://relay.contextvm.org
  wss://relay2.contextvm.org
  wss://relay.primal.net
```

The coordinator and relays are routing infrastructure; MLS message content remains encrypted in transit. Override these values with `--server-pubkey` and `--relay` when using another deployment. Explicit options take precedence over restored state, restored state over environment configuration, and environment configuration over bundled defaults.

## Coordinator transport

By default, requests to the coordinator are plaintext ContextVM events. MLS payloads inside them stay end-to-end encrypted, but anyone reading the relays can see which method was called, the delivery group id, cursors, sizes and timing, and which client key made the request.

`--transport-encryption required` (or `CORDN_TRANSPORT_ENCRYPTION=required`) sends every request as a NIP-59 gift wrap of the ephemeral kind, which relays do not store, so that envelope is hidden from relay operators. The coordinator answers in the same mode; the stock server accepts both. Because the ephemeral kind is never stored by relays, a response that arrives while the client is between polls is gone; only a caller retry re-requests it.

It also matters with more than one relay. Since `@contextvm/sdk` 0.14.2 the transport de-duplicates requests by event id in both modes, so a request carried by N relays is processed once (and a posted message stored at one cursor) whether or not encryption is on. Encryption itself is purely about the privacy above. Library callers pass `transportEncryption: "required"` to `openPersistentSession`.

One caveat, in either mode (`@contextvm/sdk` 0.14.2): requests carry no nonce by design — a Nostr event id is the identity of a publication, so an accidental duplicate (double-click, retry storm, relay redelivery) is collapsed instead of executed twice. The flip side: a client that restarts and repeats a request the previous process already sent, within the same second and with the same key, sends a byte-identical event, and that one request goes unanswered until it times out. It self-heals, but recovery is caller-driven — the transport does not retry: re-run the command, or let the daemon's next poll (which the CLI already wraps in its own catch-and-continue loop) land in a new second with a new event id. Separate processes sharing one identity can collide the same way.

The CLI retains `CORDN_SERVER_PRIVATE_KEY` only as a local-development fallback for deriving a coordinator public key. Never distribute a coordinator private key to clients.

## Client identity and snapshot

The encrypted snapshot contains:

- the client private identity key
- private KeyPackage material
- MLS group states and epoch secrets
- message history and cursors
- pending protocol operations and acknowledgements

The companion state-key file decrypts all of it. Protect both files with mode `0600`, keep their parent directory private, and back them up together through an encrypted channel.

Losing the snapshot loses MLS continuity and history. Losing the state key makes the snapshot unrecoverable. Copying both gives the recipient control of the client identity and group membership.

The CLI writes snapshots with AES-256-GCM through a flushed temporary file and atomic rename. It exclusively locks a snapshot while in use; never bypass or manually remove a lock belonging to a running process.

## Command output

`status` prints only the stable public key and object counts.

`whoami` prints the private identity key as well as the public key. Use it only in a private terminal when explicit private-key export is intended. Do not invoke it from general-purpose agents, logs, CI, or support transcripts.

KeyPackage references, stable public keys, coordinator keys, group cursors, and event IDs are public identifiers. Snapshot keys and client/coordinator private keys are secrets.

## Filesystem queues

The inbox contains decrypted plaintext. The outbox accepts plaintext that the daemon will send as the client identity.

Restrict queue ownership and permissions. Validate schemas, authorize group aliases and stable senders, cap input size and rate, and persist deduplication before deleting claimed input.

The filesystem boundary protects the MLS ratchet by leaving the daemon as its only writer. It does not sandbox another process running as the same operating-system user. For stronger isolation, run the daemon and automation as separate users and grant only the required queue access.

## AI integrations

Sending decrypted group content to a model provider extends the privacy boundary beyond Cordn. Use an explicit bot identity and disclose the provider and retention policy to group members.

Disable model tools by default. If tools are required, sandbox them and separately authorize capabilities; group messages are untrusted input and may contain prompt-injection attempts. Prevent bot-to-bot response loops and apply token/rate budgets.

## Operational guidance

- Pin the installed CLI version for long-running daemons.
- Run daemons under a service manager with controlled restart policy.
- Monitor stderr, quarantined jobs, queue depth, and state-write failures.
- Gracefully stop the daemon before backups or upgrades.
- Test snapshot restoration before depending on a backup.
- Remove abandoned bot members from groups after destroying their local identity state.
