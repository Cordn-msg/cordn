# cordn

## 0.4.0

### Minor Changes

- refactor(coordinator)!: drop epoch awareness, legacy MLS-decode routing, and plaintext outbound

  Completes the private-coordinator rollout. The coordinator is now opaque-only:
  it stores and replays encrypted MLS ciphertext and no longer parses group
  routing metadata from message bodies. This is a breaking contract change.

  ### Removed (BREAKING)
  - **Epoch awareness** — `since_epoch` filtering on `fetchGroupMessages` /
    `subscribeGroupMessages`, stale-handshake rejection, and the `epoch` /
    `latestHandshakeEpoch` fields on records and routing types. Group delivery
    cursors remain monotonic per group; filtering is purely cursor-based now.
  - **Legacy MLS-decode routing** — `gid` is now **required** on
    `postGroupMessage`. The coordinator no longer decodes opaque messages to
    derive a group id (`decodeOpaqueMessage`, `getMessageMetadata`,
    `resolveLatestHandshakeEpoch`, and the MLS decoder imports are gone); every
    inbound message takes the opaque path.
  - **`getGroupRouting`** — removed from the coordinator and the public exports.
  - **Plaintext outbound (CLI)** — the `encryptOutbound` option is gone; outbound
    group messages are always encrypted (the group id is always derived and the
    payload always encrypted before posting).

  ### Migrations

  SQLite gains guarded `ALTER TABLE ... DROP COLUMN` migrations for
  `group_messages.epoch` and `group_routing.latest_handshake_epoch`, mirroring the
  existing `ephemeral_sender_pubkey` precedent. Legacy databases keep their rows;
  the columns are dropped on next startup. New databases never create them.

  ### Kept (transitional)

  The `encrypted` boolean on `GroupMessageRecord` and the response schema stays.
  It is now always `true` from the coordinator; it remains so deployed reads can
  distinguish any pre-rollout rows until none remain, after which the field and
  the CLI read-path branch can collapse.

### Patch Changes

- Fix leaked group-message subscriptions on silent client disconnect.

  Server-side subscribe handlers now listen to the `OpenStreamWriter` `signal`
  (`@contextvm/sdk` 0.13.8+) and tear down the coordinator subscription when it
  aborts. Previously a subscriber was only removed when `stream.abort()` was
  called explicitly; on Nostr a client that silently disappeared (crash, sleep,
  network drop) never triggered that path, so the subscriber lived forever. Each
  new group message was then fanned out — and relay-published — for every leaked
  subscriber, degrading throughput over time while memory stayed flat.

  Bumping to `@contextvm/sdk` 0.13.8 supplies the underlying fix: the writer now
  self-aborts on keepalive probe timeout and exposes a `signal` that fires on
  every termination. Our wiring covers the `dispose()`/transport-teardown path
  that the existing `stream.abort` override misses; the override still claims the
  log reason on explicit aborts.

  Also fixes `getActiveSubscriptionCount()`, which previously summed group-Set
  sizes and so over-counted a multi-group subscription once per group it joined
  (one subscription to N groups reported as N). It now refcounts distinct
  subscriber objects, so the `activeSubscriptions` value in the logs reflects real
  subscriptions (and reads in O(1) instead of iterating every group).

## 0.3.4

### Patch Changes

- perf(server): trim redundant crypto and encoding work on the message path

  Three low-risk optimizations that reduce per-message CPU without changing
  behavior or the public API:
  - Drop the redundant `verifyEvent` in `publishKeyPackage`. The ContextVM SDK's
    `ServerEventPipeline` already verifies every inbound request event's
    signature before dispatch (the identity-forgery fix), so re-running schnorr
    verification on the same inner event is wasted work. The credential-to-signer
    binding check is retained — only cordn can enforce that.
  - Single-pass `decodeBase64`. The previous decode -> re-encode -> string-compare
    round-trip is replaced by one charset + padding-length check before decode.
    Same rejection criteria (empty/whitespace-only and non-canonical input still
    throw). Removes one base64 encode plus a full-input scan per inbound message
    (`postGroupMessage`, `storeWelcome`, `publishKeyPackage`).
  - Serialize-once fanout. A `WeakMap` caches the base64 + JSON wire string per
    `GroupMessageRecord`, so a live message fanned out to N subscribers is
    serialized once instead of N times. Backlog fetches return fresh objects per
    client and miss the cache by design; entries are GC'd with the record.

  These shave edge cost on the coordinator path. The dominant spike cost remains
  the SDK's per-subscriber NIP-44 gift-wrap (ECDH + ChaCha20-Poly1305 + schnorr
  sign), which is outside cordn and unchanged.

## 0.3.3

### Patch Changes

- fix(storage): refresh re-requested join entries to prevent stale consumption

  Update in-memory and SQLite storage to bump `createdAt` and refresh
  `keyPackageRef` when a join request is re-submitted by the same
  requester. This prevents the admin’s existing consume reference from
  retiring the stale row and avoids forcing the user to send twice.

  Also bump @contextvm/sdk to ^0.13.3.

## 0.3.2

### Patch Changes

- 69862ae: chore(deps): bump @contextvm/sdk to ^0.13.2 and remove stale JSDoc

## 0.3.1

### Patch Changes

- refactor(coordinator): drop ephemeralSenderPubkey from postGroupMessage

  The postGroupMessage method no longer requires an ephemeral public key from
  callers; the coordinator now generates or manages it internally. Update all
  test invocations to reflect the API change.

## 0.3.0

### Minor Changes

- 6cd46aa: feat(coordinator)!: replace read/unread TTLs with a max-age ceiling and explicit consumed acks

  Welcomes and join requests are no longer retired by a read timer. Records are
  deleted only when the caller explicitly acknowledges consumption, or when their
  age exceeds a single max-age ceiling. Fetching never deletes; the owner
  explicitly retires their own key packages and join requests.

  ### Added
  - Optional `consumed` parameter on `fetchPendingWelcomes` (keyed by `kp_ref` +
    `at`), `fetchPendingJoinRequests` (keyed by `pk` + `at`), and
    `fetchManyPendingJoinRequests` (keyed by `gid` + `pk` + `at`). Consumed
    records are deleted atomically before the fetch, so they are never echoed
    back. The ack is idempotent, so re-sends after a failed fetch are safe.

  ### Removed / renamed (BREAKING)

  Retention is now a single clock instead of three. Existing SQLite databases
  keep their legacy `read_at` columns harmlessly ignored (INSERTs/SELECTs
  enumerate columns explicitly); new databases omit them.

  Environment variables:
  - `CORDN_UNREAD_MAX_AGE_DAYS` → renamed to `CORDN_MAX_AGE_DAYS` (default 30,
    unchanged).
  - `CORDN_WELCOME_TTL_HOURS` → removed (the read TTL it drove no longer exists).
  - `CORDN_WELCOME_CLEANUP_INTERVAL_MINUTES` → removed. With only the
    multi-day max age left to reap, the cleanup cadence is no longer env-tunable;
    the coordinator runs it on a fixed internal default of 6h (was 1h). Deployments
    relying on the defaults need no action.

  `CoordinatorOptions` (programmatic API):
  - `welcomeMaxAgeMs` → renamed to `maxAgeMs`.
  - `welcomeTtlMs` → removed.
  - `welcomeCleanupIntervalMs` → renamed to `cleanupIntervalMs`, retained as a
    programmatic/test knob (pass `0` to disable the timer in tests); no longer
    env-exposed.

  Server runtime config: the nested `retention: { cleanupIntervalMs, maxAgeMs }`
  field is flattened to a top-level `maxAgeMs`. `createConfiguredCoordinator`
  now takes `maxAgeMs?: number` directly instead of the retention object.

  Records: the `readAt` field and read-based deletion are removed from welcome
  and join-request records. Callers must pass `consumed` refs to retire records.

  ### Upgrade notes
  - Operators: rename `CORDN_UNREAD_MAX_AGE_DAYS` → `CORDN_MAX_AGE_DAYS` if set.
    Remove `CORDN_WELCOME_TTL_HOURS` and `CORDN_WELCOME_CLEANUP_INTERVAL_MINUTES`
    (ignored if present; defaults apply). Existing SQLite DBs need no migration.
  - Programmatic consumers: rename `welcomeMaxAgeMs` → `maxAgeMs` and
    `welcomeCleanupIntervalMs` → `cleanupIntervalMs`; drop `welcomeTtlMs`.
  - The pending-join-request cap now counts ALL pending requests per group (was
    unread-only). Groups with many legacy "read" requests may hit the cap sooner
    on upgrade until those records age out (≤30d); benign convergence, not a crash.

- 6cd46aa: feat(server): visual startup banner with nprofile and cordn.net setup URL

  The coordinator server now prints a multi-line banner to stdout at startup
  instead of a single JSON splash line, making it easier to visually identify a
  running server and copy its connection details.
  - Show the hex `pubkey` alongside an `nprofile` (NIP-19 encoding of the pubkey
    plus the configured relays as hints), so clients can target the server by a
    single self-contained identifier.
  - Print a `https://cordn.net/chat/coordinators?c=<nprofile>` URL that adds
    this coordinator automatically when opened, lowering the setup cost for new
    users.
  - The banner is written to `stdout` (not pino) so line breaks and symbols
    render for operators instead of being JSON-escaped. The structured
    `serverPubkey` is still emitted in the later "connected" JSON log line, so
    machine consumers lose nothing.

- 6cd46aa: feat(coordinator): deliver group messages as opaque sealed payloads

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

### Patch Changes

- 28640d8: chore(deps): adopt @contextvm/mcp-sdk, bump @contextvm/sdk to 0.12.4

## 0.2.3

### Patch Changes

- test: add oversized catch-up integration tests and bump @contextvm/sdk

  Add integration tests for CEP-22 oversized-transfer bounded catch-up
  scenarios, covering both disabled and gift-wrap encryption modes. The
  tests verify that aggregated oversized responses are chunked and
  reassembled correctly, and reproduce a known failure with gift-wrap
  encryption where chunk frames are not emitted.

  Bump @contextvm/sdk to ^0.12.3 to pick up the necessary SDK changes
  for oversized transfer handling.

## 0.2.2

### Patch Changes

- chore(deps): bump @contextvm/sdk from 0.11.14 to 0.12.2

## 0.2.1

### Patch Changes

- feat: add fetchManyPendingJoinRequests batch method for join requests

## 0.2.0

### Minor Changes

- 188f9d0: feat(coordinator): add join request feature for group membership

  Implement join request functionality allowing users to request to join groups
  via shareable links. Includes storage implementations (in-memory and SQLite),
  CLI commands (fetch-join-requests, request-join), server methods, and cleanup
  timer extensions for automatic expiration. Also adds configurable max age for
  unread welcomes and join requests via CORDN_UNREAD_MAX_AGE_DAYS environment
  variable.

### Patch Changes

- 15a214e: feat(coordinator): add per-group cap for join requests

  Removes group existence validation to allow join requests for newly
  created groups without message history (bootstrap scenario). Adds a
  per-group cap of 100 pending join requests to prevent unbounded
  accumulation from fake group IDs while remaining generous enough for
  real groups.

## 0.1.10

### Patch Changes

- fix(sqlite): exclude NULL epochs from sinceEpoch filtering when > 0

  Previously, NULL epochs (legacy data) were always included in sinceEpoch
  filtering, which could return messages with unknown epochs even when a
  positive sinceEpoch was specified. Now, NULL epochs are excluded when
  sinceEpoch > 0, and included only when sinceEpoch = 0 for backward
  compatibility. Updated SQL queries and added tests.

## 0.1.9

### Patch Changes

- feat(coordinator): add epoch-based filtering for group messages

  Add `since_epoch` parameter to `fetchGroupMessages` to allow clients to retrieve messages from a specific epoch onward. Update storage implementations (in-memory and SQLite) to store and filter by epoch. This enables efficient message retrieval based on epoch boundaries.

## 0.1.8

### Patch Changes

- feat(coordinator): preserve unread welcomes past TTL

  Mark fetched welcomes with a readAt timestamp so cleanup only removes
  welcomes that have been read and are older than the TTL. Default TTL
  lowered from 24h to 1h. Unread welcomes are now retained indefinitely
  regardless of age, ensuring members do not lose pending invites.
  - Add readAt field to WelcomeQueueRecord (null until first fetch)
  - Update fetchPendingWelcomes to stamp readAt on returned records
  - Update deleteExpiredWelcomes to skip records with null readAt
  - Change default welcomeTtlMs from 86_400_000 to 3_600_000
  - Adjust inMemoryStorage to support read tracking
  - Add tests covering read marking and unread retention behavior

## 0.1.7

### Patch Changes

- coordinator: replace destructive welcome drain with TTL-based non-destructive storage

  FetchPendingWelcomes no longer deletes welcomes on read. Welcomes are now
  retained on the coordinator and cleaned up via a periodic TTL sweep instead
  of being drained at fetch time. This eliminates permanent welcome loss when
  the relay response fails to reach the client after the coordinator already
  deleted the records.

## 0.1.6

### Patch Changes

- feat(coordinator): add FetchManyGroupMessages API for multi-group bounded catch-up

## 0.1.5

### Patch Changes

- feat(coordinator): add multi-group subscription API with optimized message queue

  Add `subscribeManyGroupMessages` and `fetchManyGroupMessages` APIs for subscribing to multiple groups through a single stream. Refactor AsyncMessageQueue to use index-based iteration with periodic memory cleanup instead of shift(), improving performance for long-running subscriptions. Includes new benchmark tool for comparing single vs multi-group subscription patterns.

## 0.1.4

### Patch Changes

- 4288cd0: feat(coordinator): add SubscribeManyGroupMessages API for multi-group streaming

  Add a new `SubscribeManyGroupMessages` method that allows clients to subscribe to messages from multiple groups in a single CEP-41 stream while preserving independent per-group cursor semantics. This enables clients tracking many groups to avoid opening separate tool calls per group, improving efficiency for large-scale group management.

  The implementation includes:
  - New `subscribeManyGroupMessages` method in the coordinator client and server adapter
  - Input/output schemas supporting an array of group subscriptions with independent cursors
  - Backlog replay and live streaming for each group with proper cursor tracking
  - Proper cleanup of all child subscriptions on abort
  - Unit tests verifying independent cursor behavior and subscription cleanup

## 0.1.3

### Patch Changes

- refactor(coordinator): remove snapshot API and add queue depth tracking

  Removes the DeliveryServiceSnapshot type and snapshot() method from Coordinator and storage implementations. Adds getDepth() and getMaxDepth() methods to AsyncMessageQueue for monitoring queue sizes. Also optimizes base64 decoding and improves subscription cleanup handling.

## 0.1.2

### Patch Changes

- Low-risk production optimizations for the coordinator and server adapter.
  - Added an injectable `ServerLogger` abstraction in `src/server/logger.ts` and wired it through `CoordinatorAdapter`, `createServer`, and `connectServer`. The runnable entrypoint (`src/server/main.ts`) now uses `pino` for structured startup and fatal-error logging.
  - Removed a duplicate MLS message decode on the group-message post path by simplifying `decodeOpaqueMessageBase64` to validate only base64 bytes, leaving MLS parsing authoritative in `Coordinator.postGroupMessage`.
  - Made `CoordinatorAdapter.subscribeGroupMessages` race-free by creating the live subscription before fetching backlog, while preserving the existing fetch-then-subscribe client model and cursor-based duplicate suppression.
  - Added SQLite production tuning: `busy_timeout = 5000` and a targeted key-package consume index `idx_key_packages_identity_last_resort_order`.
  - Reduced SQLite read-copy overhead by changing `toUint8Array` to return a view instead of copying buffers.
  - Added a startup advisory log in `src/server/main.ts` that prominently prints the server Nostr public key with an emoji so operators immediately know which pubkey clients must target.
  - Added lightweight per-method operation counters in `CoordinatorAdapter` that emit structured `info` logs (`type: "operation"`) after every successful publish, consume, remove, store, post, fetch, and subscribe call.
  - Added stale-handshake rejection logging (`type: "stale_handshake"`) in `CoordinatorAdapter.postGroupMessage` so security-relevant drops are visible in logs.
  - Added subscription lifecycle logging (`type: "subscription_start"` / `type: "subscription_end"`) together with an active-subscription gauge derived from `Coordinator.getActiveSubscriptionCount()`.

## 0.1.1

### Patch Changes

- feat(server): add abuse protection with rate limiting and key package quotas

  Implements homogeneous token bucket rate limiting keyed by client pubkey and
  per-identity key package storage quotas. Rate limit and quota rejections can
  be logged via environment variables. The default configuration allows 250
  requests/minute with burst of 80, and permits up to 50 key packages (including
  1 last-resort) per stable identity. The default storage backend is now memory
  for simpler local development.

  BREAKING CHANGE: Default CORDN_STORAGE_BACKEND changed from sqlite to memory.
  For persistent deployments, explicitly set CORDN_STORAGE_BACKEND=sqlite.

## 0.1.0

### Minor Changes

- Init
