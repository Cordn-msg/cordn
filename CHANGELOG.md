# cordn

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
