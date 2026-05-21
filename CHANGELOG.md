# cordn

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
