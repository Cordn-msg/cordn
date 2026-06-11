# cordn

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
