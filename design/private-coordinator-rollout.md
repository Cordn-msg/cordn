# Private Coordinator Rollout Plan

Companion to [`design/private-coordinator-refactor.md`](./private-coordinator-refactor.md). Covers encryption mechanics, overhead analysis, blast radius, migration strategy, and implementation order.

## Encryption Model

### How it works

Two encryption layers wrap every group message:

1. **MLS layer** (standard, already in use) — `createApplicationMessage()` encrypts the cordn message envelope into an MLS PrivateMessage
2. **Payload encryption layer** (new) — the serialized MLS message bytes are encrypted with a ChaCha20-Poly1305 AEAD key derived from the MLS exporter secret

Wire format after this refactor:

```
msg_64 = base64(12-byte-nonce || ChaCha20-Poly1305-ciphertext-with-16-byte-auth-tag)
```

### Key derivation

The encryption key is derived deterministically from the current MLS epoch's exporter secret:

```
encryption_key = MLS-Exporter(exporter_secret, "cordn", "group-payload", 32)
```

Every group member in the same epoch shares the same `exporter_secret` and therefore computes the identical key. No key material is transmitted — it's derived locally from MLS state that all members already hold.

### Encryption (client-side, before posting)

```typescript
const serializedMessage = encode(mlsMessageEncoder, mlsMessage);
const key = await mlsExporter(state.keySchedule.exporterSecret, "cordn", "group-payload", 32, ciphersuite);
const nonce = randomBytes(12);
const ciphertext = chacha20poly1305(key, nonce, new Uint8Array(0)).encrypt(serializedMessage);
const msg_64 = encodeBase64(concatBytes(nonce, ciphertext));
```

### Decryption (client-side, after fetching)

```typescript
const payload = decodeBase64(record.msg_64);
const nonce = payload.subarray(0, 12);
const ciphertext = payload.subarray(12);
const key = await mlsExporter(state.keySchedule.exporterSecret, "cordn", "group-payload", 32, ciphersuite);
const serializedMessage = chacha20poly1305(key, nonce, new Uint8Array(0)).decrypt(ciphertext);
const mlsMessage = decode(mlsMessageDecoder, serializedMessage);
```

### Why decryption fails for messages from unknown epochs

If a client receives a message from an epoch they have not joined, they cannot derive the correct `encryption_key` because their `exporterSecret` differs. The ChaCha20-Poly1305 auth tag check fails, and the message is naturally skipped. This eliminates the need for server-side `since_epoch` filtering.

### Dependencies

| Dep | Needed by | Already in cordn? |
|---|---|---|
| `ts-mls` (`mlsExporter`, `mlsMessageEncoder`, `encode`, `decode`) | Client-side encrypt/decrypt | Yes |
| `@noble/ciphers` (`chacha20poly1305`, `randomBytes`, `concatBytes`) | Client-side encrypt/decrypt | **No** — new |

`@noble/ciphers` is ~15 KB, zero native dependencies, pure JavaScript. Works in Node, Bun, and Deno. Only needed at the client (CLI), never at the coordinator server.

## Overhead

| Metric | Value | Impact |
|---|---|---|
| Per-message size overhead | 28 bytes (12 nonce + 16 auth tag) | 5–14% for typical messages, <1% for commits |
| CPU cost | Single-digit microseconds | ChaCha20-Poly1305 throughput: ~1–3 GB/s per core |
| Additional round trips | 0 | Key is derived locally, not negotiated |
| New client state | 0 | Key is derived from existing MLS `exporterSecret` |

## Benefits

| Benefit | Explanation |
|---|---|
| **Server blindness to MLS metadata** | Coordinator cannot read epoch, content type, wireformat, or inner MLS `group_id` |
| **Decoupled routing identity** | Outer delivery `gid` does not need to equal inner MLS `group_id` |
| **Forward secrecy at transport layer** | Encryption key rotates automatically with every epoch change |
| **Natural epoch filtering** | Messages from epochs the client has not joined fail decryption — no server-side `since_epoch` needed |
| **Simpler coordinator** | Less MLS parsing in server code, fewer attack surfaces |
| **Cryptographic boundary** | Coordinator *cannot* decode metadata, even if compromised — "can't" vs "chooses not to" |

## What the coordinator sees before and after

### Today

```
coordinator decodes MLS → extracts groupId, epoch, handshakeMessage
                         → routes by groupId
                         → filters by epoch (since_epoch)
                         → rejects stale handshakes
```

### After

```
coordinator receives { gid, msg_64 }
           → routes by gid (caller-supplied)
           → stores opaque encrypted bytes
           → assigns cursor
           → no MLS decoding
           → no epoch awareness
           → no handshake tracking
```

## Rollout Strategy: Deprecation, Not Deletion

Since cordn controls the only client, the rollout is straightforward. The approach is additive with deprecation markers — no code is deleted until a cleanup phase after all clients have migrated.

### Phase 1: Add encrypted support (additive)

**Database:**
```sql
ALTER TABLE group_messages ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE welcomes ADD COLUMN join_after_cursor INTEGER;
```

Existing rows default to `encrypted = 0` (legacy). New encrypted messages are stored with `encrypted = 1` and `epoch = NULL`. The `group_routing` table remains — it continues tracking `lastMessageCursor` for cursor allocation but stops being written with new `latestHandshakeEpoch` values for encrypted messages.

**Single table, shared cursor sequence:** Both legacy and encrypted messages share the same `group_messages` table and the same monotonic per-group cursor sequence. This ensures clients with mixed versions operating in the same group see an uninterrupted message stream.

**Contracts (additive):**

- [`groupMessageSchema`](src/contracts/index.ts:160): add `encrypted: z.boolean().optional()`
- [`pendingWelcomeSchema`](src/contracts/index.ts:80): add `after: z.number().optional()`
- [`storeWelcomeInputSchema`](src/contracts/index.ts:92): add `after: z.number().optional()`
- [`postGroupMessageInputSchema`](src/contracts/index.ts:141): add `gid: z.string().min(1)` — required for encrypted messages, optional (backward-compatible) for legacy

**Coordinator (additive):**

- [`postGroupMessage()`](src/coordinator/coordinator.ts:328): accept `groupId` from input. When payload is encrypted, skip MLS decoding and use caller-supplied `groupId` directly. When legacy, decode as today.
- [`storeWelcome()`](src/coordinator/coordinator.ts:267): accept and persist `joinAfterCursor`

**Deprecation markers (do NOT delete):**

- `decodeOpaqueMessage()` — mark `@deprecated`
- `getMessageMetadata()` — mark `@deprecated`
- `resolveLatestHandshakeEpoch()` — mark `@deprecated`
- `parseSinceEpoch()` — mark `@deprecated`
- `since_epoch` on [`fetchGroupMessagesInputSchema`](src/contracts/index.ts:154) — mark `@deprecated`

**Client:**

- New CLI version encrypts payloads before posting, decrypts after fetching
- Sends `gid` (outer delivery group id) with every post
- Uses `welcome.after` to initialize fetch cursor on join
- Old CLI version sees `encrypted: true` on unknown messages → cannot decode → displays "update your client" warning

**Tests:**

- Keep all existing tests (legacy path still works)
- Add new tests for encrypted path
- Do not remove any `since_epoch` or stale handshake tests

### Phase 2: Cleanup (after all clients have migrated)

Once no client uses the legacy path:

1. Remove `decodeOpaqueMessage()`, `getMessageMetadata()`, `resolveLatestHandshakeEpoch()` from [`coordinator.ts`](src/coordinator/coordinator.ts)
2. Remove MLS decoder imports (`contentTypes`, `mlsMessageDecoder`, `wireformats`) from coordinator code
3. Remove `parseSinceEpoch()` from [`coordinatorMethods.ts`](src/server/coordinatorMethods.ts)
4. Remove stale handshake catch block from server adapter
5. Remove `since_epoch` from contracts
6. Remove `since_epoch` filter branches from both storage backends
7. Drop `epoch` column from `group_messages`
8. Drop `latest_handshake_epoch` column from `group_routing` (or drop entire `group_routing` table)
9. Remove corresponding tests

## Blast Radius

### Source files to modify (Phase 1, additive)

| File | Changes |
|---|---|
| [`src/contracts/index.ts`](src/contracts/index.ts) | Add `encrypted`, `after`, `gid` fields; deprecate `since_epoch` |
| [`src/coordinator/types.ts`](src/coordinator/types.ts) | Add `groupId` to `PostGroupMessageInput`, `joinAfterCursor` to Welcome types; deprecate `epoch`/`latestHandshakeEpoch`/`sinceEpoch` |
| [`src/coordinator/coordinator.ts`](src/coordinator/coordinator.ts) | Add encrypted path in `postGroupMessage()`, `storeWelcome()`; deprecate 3 helper functions |
| [`src/coordinator/storage/storage.ts`](src/coordinator/storage/storage.ts) | Deprecate `latestHandshakeEpoch`/`epoch` in `AppendGroupMessageParams` |
| [`src/coordinator/storage/inMemoryStorage.ts`](src/coordinator/storage/inMemoryStorage.ts) | Handle `encrypted` flag, `joinAfterCursor`, NULL epoch |
| [`src/coordinator/storage/sqliteStorage.ts`](src/coordinator/storage/sqliteStorage.ts) | Add `encrypted` column, `join_after_cursor` column; handle new fields in queries |
| [`src/server/coordinatorMethods.ts`](src/server/coordinatorMethods.ts) | Add `encrypted` to `mapGroupMessage()`, pass `gid`/`after`; deprecate `parseSinceEpoch` |
| [`src/cli/coordinatorClient.ts`](src/cli/coordinatorClient.ts) | Add `gid` to post, handle `encrypted`/`after` in responses |
| [`src/cli/session.ts`](src/cli/session.ts) | Encrypt before post, decrypt after fetch, derive `gid`, capture Welcome cursor |
| [`src/cli/pendingEpochOperations.ts`](src/cli/pendingEpochOperations.ts) | Add `joinAfterCursor` to pending add-member op |
| [`src/cli/membershipFlow.ts`](src/cli/membershipFlow.ts) | Pass `joinAfterCursor` through add-member flow |
| [`src/cli/utils/mlsMessages.ts`](src/cli/utils/mlsMessages.ts) | Add `encryptGroupPayload()` and `decryptGroupPayload()` |
| [`src/coordinator/index.ts`](src/coordinator/index.ts) | May need type re-export updates |

### Test files to update (Phase 1, additive only)

| File | Changes |
|---|---|
| [`src/coordinator/coordinator.test.ts`](src/coordinator/coordinator.test.ts) | Add encrypted path tests; keep all legacy tests |
| [`src/coordinator/coordinator.integration.test.ts`](src/coordinator/coordinator.integration.test.ts) | Keep existing; no removal |
| [`src/coordinator/storage/storage.test.ts`](src/coordinator/storage/storage.test.ts) | Add `joinAfterCursor` round-trip, encrypted flag persistence; keep `sinceEpoch` tests |
| [`src/server/coordinatorServer.test.ts`](src/server/coordinatorServer.test.ts) | Add `encrypted` contract tests, `after` Welcome contract tests; keep `since_epoch` tests |
| [`src/cli/session.integration.test.ts`](src/cli/session.integration.test.ts) | Add encrypted send/receive and Welcome `after` efficient-join scenario |
| [`src/cli/groupSync.test.ts`](src/cli/groupSync.test.ts) | Update mocks for decryption step |
| [`src/coordinator/storage/sqliteSubscriptionBenchmark.ts`](src/coordinator/storage/sqliteSubscriptionBenchmark.ts) | Minor: handle NULL epoch in test data |

### Files NOT affected

These files require no changes:
- `src/mlsCodec.ts` — Welcome encode/decode only
- `src/server/base64.ts`, `src/server/rateLimit.ts`, `src/server/logger.ts` — utilities
- `src/server/main.ts`, `src/server/runtimeConfig.ts` — server config
- `src/lastResortKeyPackage.ts` — key packages
- `src/cli/repl.ts`, `src/cli/replCommands.ts`, `src/cli/replFormat.ts` — REPL
- `src/cli/sessionStore.ts`, `src/cli/sessionState.ts` — state (add `joinAfterCursor` to pending op type only)
- `src/cli/groupMetadata.ts`, `src/cli/adminPolicy.ts` — extensions
- `src/cli/groupWatch.ts`, `src/cli/messageEnvelope.ts`, `src/cli/sessionErrors.ts` — utilities
- `src/cli/utils/mlsBase.ts`, `src/cli/utils/mlsEncoding.ts`, `src/cli/utils/mlsGroupLifecycle.ts`, `src/cli/utils/mlsIdentity.ts`, `src/cli/utils/publishedKeyPackage.ts` — utilities
- `src/test/mockRelay.ts` — test infra

### Important: client-side epoch handling stays

The following code handles MLS processing errors **client-side** and is NOT changed:
- [`isFormerEpochIssue()`](src/cli/groupSync.ts:30) in [`groupSync.ts`](src/cli/groupSync.ts)
- All [`pendingEpochOperations.ts`](src/cli/pendingEpochOperations.ts) logic
- All `isStaleGenerationIssue()`, `isUndecryptableStaleMessageIssue()`, `isRemovedMemberCommitIssue()` in [`groupSync.ts`](src/cli/groupSync.ts)

These functions handle the MLS library's own epoch validation during local message processing. They have nothing to do with coordinator-level epoch tracking and remain unchanged.

## Deprecation Reference

### Functions to deprecate (do NOT delete in Phase 1)

| Function | File | Reason |
|---|---|---|
| `decodeOpaqueMessage()` | [`src/coordinator/coordinator.ts:41`](src/coordinator/coordinator.ts:41) | Coordinator no longer decodes MLS for encrypted messages |
| `getMessageMetadata()` | [`src/coordinator/coordinator.ts:50`](src/coordinator/coordinator.ts:50) | Metadata extraction from MLS payloads |
| `resolveLatestHandshakeEpoch()` | [`src/coordinator/coordinator.ts:78`](src/coordinator/coordinator.ts:78) | Handshake epoch tracking |
| `parseSinceEpoch()` | [`src/server/coordinatorMethods.ts:100`](src/server/coordinatorMethods.ts:100) | Server-side epoch filtering |

### Contract fields to deprecate (do NOT remove in Phase 1)

| Field | Schema | Reason |
|---|---|---|
| `since_epoch` | [`fetchGroupMessagesInputSchema`](src/contracts/index.ts:154) | Replaced by cursor-only fetch |
| `epoch` | `GroupMessageRecord` | Coordinator no longer extracts epoch |
| `latestHandshakeEpoch` | `GroupRoutingRecord` | Coordinator no longer tracks handshake epochs |

### SQL columns to deprecate (keep physically, stop writing)

| Column | Table | Reason |
|---|---|---|
| `epoch` | `group_messages` | Written as NULL for encrypted messages |
| `latest_handshake_epoch` | `group_routing` | Stop updating for new messages |

## Welcome Cursor Hint (`after`)

The `welcome.after` field enables efficient post-join sync without server-side epoch awareness:

```
1. Inviter creates MLS Commit + Welcome
2. Inviter posts Commit to coordinator with outer gid → coordinator returns cursor C
3. Inviter stores Welcome with after = C
4. Invitee fetches Welcome, reads after = C
5. Invitee initializes fetchCursor = C
6. Invitee fetches messages with after = C — skips pre-join messages

Example:
  cursor 98: pre-join message    ← skipped (invitee fetches after C=100)
  cursor 99: pre-join message    ← skipped
  cursor 100: Commit adding Bob  ← Welcome.after = 100
  cursor 101: post-join message  ← fetched and decrypted
  cursor 102: post-join message  ← fetched and decrypted
```

Old Welcome records without `after` default to `after = 0` (fetch all messages from cursor 1).

## Cursor Consistency (Single Table)

Both legacy and encrypted messages share the same `group_messages` table and cursor sequence:

- `PRIMARY KEY (group_id, cursor)` is unchanged
- `encrypted = 0` rows: legacy, epoch populated, MLS-decoded groupId
- `encrypted = 1` rows: encrypted, epoch NULL, caller-supplied groupId
- `fetchGroupMessages({ groupId, after })` returns both types interleaved by cursor
- `group_message` response schema includes `encrypted` discriminator

This ensures clients with mixed versions operating in the same group see an uninterrupted, correctly ordered message stream. Old clients skip encrypted messages (can't decode → warn "update your client").

## Implementation Order

1. **Contracts and types** — Add `encrypted`, `after`, `gid` fields; deprecate `since_epoch`
2. **Storage** — Add `encrypted` column, `join_after_cursor` column; handle NULL epoch
3. **Coordinator** — Add encrypted path in `postGroupMessage()`; deprecate helper functions
4. **Server adapter** — Add `encrypted` flag in `mapGroupMessage()`; pass `gid`/`after`
5. **CLI client transport** — Update `PostGroupMessage` to include `gid`
6. **CLI encryption helpers** — Add `encryptGroupPayload()` / `decryptGroupPayload()` in [`mlsMessages.ts`](src/cli/utils/mlsMessages.ts)
7. **CLI session** — Encrypt before post, decrypt after fetch, derive `gid`, capture Welcome cursor
8. **CLI add-member flow** — Store and use `joinAfterCursor`
9. **Tests** — Add encrypted path tests; keep all legacy tests
10. **Typecheck** — `pnpm run typecheck`
11. **Test suite** — `pnpm run test`

### Targeted test commands

```bash
pnpm exec vitest run src/coordinator/coordinator.test.ts
pnpm exec vitest run src/coordinator/storage/storage.test.ts
pnpm exec vitest run src/server/coordinatorServer.test.ts
pnpm exec vitest run src/cli/session.integration.test.ts
pnpm exec vitest run src/cli/groupSync.test.ts
```

## Summary

```
Coordinator-visible (after refactor):
  outer delivery gid
  per-group cursor
  opaque encrypted payload bytes
  encrypted flag
  Welcome join-after cursor hint

Client-only:
  MLS group ID
  MLS epoch
  MLS wireformat
  MLS content type
  sender identity
  application message contents
  encryption/decryption keys (derived from MLS exporter secret)
```
