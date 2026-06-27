# Private Coordinator Refactor Plan

## Goal

Move [`cordn`](../package.json) toward a Marmot-style private delivery model where coordinators are deliberately dumb:

- coordinators route and order group messages by an outer delivery group identifier
- coordinators assign monotonic per-group cursors
- coordinators store opaque encrypted group payloads
- coordinators do not decode MLS payloads
- coordinators do not learn MLS epochs, wireformats, content types, or handshake/application classification
- efficient post-Welcome sync is preserved with a cursor hint on Welcome records

This plan is intended to support the next implementation iteration and keep the refactor clean, consistent, and free of redundant legacy code.

## Key Insights

### Marmot encrypts the whole MLS payload

Marmot `kind: 445` group events use an outer routing envelope plus an encrypted MLS payload:

```text
serialized_mls_message = MLSMessage bytes
exporter_secret = MLS-Exporter("marmot", "group-event", 32)
encryption_key = exporter_secret
nonce = Random(12)
ciphertext = ChaCha20-Poly1305.encrypt(
  key = encryption_key,
  nonce = nonce,
  plaintext = serialized_mls_message,
  aad = ""
)
event.content = base64(nonce || ciphertext)
```

The coordinator/relay sees only outer metadata:

```json
{
  "kind": 445,
  "pubkey": "fresh ephemeral Nostr pubkey",
  "tags": [["h", "outer_delivery_group_id"]],
  "content": "base64(nonce || encrypted MLSMessage)"
}
```

The research script [`marmot-research/analyze-messages.ts`](../marmot-research/analyze-messages.ts) confirmed that the sample payloads in [`marmot-research/events-jsonl`](../marmot-research/events-jsonl) decode as `nonce || ciphertext`, not raw MLS messages.

### The outer group ID is a delivery routing key

Once the MLS payload is encrypted, the coordinator cannot derive `groupId` from the inner MLS message. Therefore posting must include an explicit outer delivery group ID.

Important privacy property: **the outer delivery group ID does not need to equal the inner MLS group ID**. Treat it as a routing topic, not as an MLS invariant.

This avoids unnecessary coupling between:

- internal MLS `group_id`
- coordinator-visible routing topic
- migration/sharding/public relay filter choices

The coordinator should not verify any relationship between the outer `gid` and the encrypted inner MLS group ID because it cannot decrypt and because requiring equality would leak unnecessary structure into the delivery layer.

### Epoch is client state; cursor is coordinator state

The current coordinator extracts MLS metadata in [`postGroupMessage()`](../src/coordinator/coordinator.ts:328), via [`decodeOpaqueMessage()`](../src/coordinator/coordinator.ts:41) and [`getMessageMetadata()`](../src/coordinator/coordinator.ts:50). That gives it `groupId`, `epoch`, and `handshakeMessage`.

In the private model:

- epoch stays entirely client-side
- content type stays entirely client-side
- stale handshake rejection moves entirely to MLS/client processing
- coordinator sync uses only per-group cursors

The cursor model in [`spec/00.md`](../spec/00.md:65) remains valid and becomes the only coordinator-visible sync primitive.

## Target Public Contract

### Post group message

Current [`postGroupMessageInputSchema`](../src/contracts/index.ts:141) only accepts `msg_64`. The target schema should require an outer delivery group ID:

```ts
export const postGroupMessageInputSchema = z.object({
  gid: z.string().min(1),
  msg_64: z.string().min(1),
});
```

`gid` means delivery group/topic, not necessarily MLS `group_id`.

### Fetch and subscribe

Keep cursor-only fetch/subscription:

```ts
export const fetchGroupMessagesInputSchema = z.object({
  gid: z.string().min(1),
  after: z.number().int().positive().optional(),
});
```

Remove `since_epoch` from:

- fetch single group messages
- fetch many group messages
- subscribe single group messages
- subscribe many group messages

### Welcome cursor hint

Add `after` to Welcome storage/fetch contracts:

```ts
export const pendingWelcomeSchema = z.object({
  kp_ref: z.string(),
  welcome_64: z.string(),
  at: z.number(),
  after: z.number().optional(),
});

export const storeWelcomeInputSchema = z.object({
  target_pk: z.string().min(1),
  kp_ref: z.string().min(1),
  welcome_64: z.string().min(1),
  after: z.number().optional(),
});
```

Public name: `after`, matching existing cursor semantics.

Internal name: `joinAfterCursor`, documenting intent.

## Target Coordinator Types

### Group messages

Update [`PostGroupMessageInput`](../src/coordinator/types.ts:63):

```ts
export interface PostGroupMessageInput {
  groupId: string;
  ephemeralSenderPubkey: string;
  opaqueMessage: Uint8Array;
}
```

Eventually remove `epoch` from [`GroupMessageRecord`](../src/coordinator/types.ts:35):

```ts
export interface GroupMessageRecord {
  cursor: number;
  groupId: string;
  ephemeralSenderPubkey: string;
  opaqueMessage: Uint8Array;
  createdAt: number;
}
```

Eventually remove `latestHandshakeEpoch` from [`GroupRoutingRecord`](../src/coordinator/types.ts:29):

```ts
export interface GroupRoutingRecord {
  groupId: string;
  lastMessageCursor: number;
}
```

### Welcomes

Update [`WelcomeQueueRecord`](../src/coordinator/types.ts:13) and [`StoreWelcomeInput`](../src/coordinator/types.ts:51):

```ts
export interface WelcomeQueueRecord {
  targetStablePubkey: string;
  keyPackageReference: string;
  welcome: Welcome;
  joinAfterCursor?: number;
  createdAt: number;
  readAt: number | null;
}

export interface StoreWelcomeInput {
  targetStablePubkey: string;
  keyPackageReference: string;
  welcome: Welcome;
  joinAfterCursor?: number;
}
```

## Target Coordinator Behavior

Replace MLS-aware posting in [`Coordinator.postGroupMessage()`](../src/coordinator/coordinator.ts:328) with opaque append-only behavior:

```ts
postGroupMessage(input: PostGroupMessageInput): GroupMessageRecord {
  const record = this.storage.appendGroupMessage({
    groupId: input.groupId,
    ephemeralSenderPubkey: input.ephemeralSenderPubkey,
    opaqueMessage: input.opaqueMessage,
    createdAt: this.now(),
  });

  this.publishLiveGroupMessage(record);
  return record;
}
```

Remove from coordinator code:

- `mlsMessageDecoder` import
- `wireformats` import
- `contentTypes` import
- `decodeOpaqueMessage()`
- `getMessageMetadata()`
- `resolveLatestHandshakeEpoch()`
- stale handshake rejection branch
- logs specifically about stale handshake rejection in [`CoordinatorAdapter.postGroupMessage()`](../src/server/coordinatorMethods.ts:588)

## Efficient Welcome Join

### Flow

The inviter already knows the MLS state and receives the coordinator cursor after posting the add-member Commit.

```text
1. inviter creates MLS Commit + Welcome
2. inviter posts Commit to coordinator with outer gid
3. coordinator appends Commit and returns cursor C
4. inviter stores Welcome with after = C
5. invitee fetches Welcome
6. invitee accepts Welcome and initializes fetchCursor = C
7. invitee fetches messages after C only
```

Example:

```text
cursor 98: old message before Bob joined      Bob cannot decrypt, skipped
cursor 99: old message before Bob joined      Bob cannot decrypt, skipped
cursor 100: Commit adding Bob                 Welcome carries after=100
cursor 101: message after Bob joined          Bob fetches and decrypts
cursor 102: message after Bob joined          Bob fetches and decrypts
```

### Store Welcome

In [`Coordinator.storeWelcome()`](../src/coordinator/coordinator.ts:267):

```ts
storeWelcome(input: StoreWelcomeInput): WelcomeQueueRecord {
  const record: WelcomeQueueRecord = {
    targetStablePubkey: input.targetStablePubkey,
    keyPackageReference: input.keyPackageReference,
    welcome: input.welcome,
    joinAfterCursor: input.joinAfterCursor,
    createdAt: this.now(),
    readAt: null,
  };

  return this.storage.storeWelcome(record);
}
```

In [`CoordinatorAdapter.storeWelcome()`](../src/server/coordinatorMethods.ts:496):

```ts
const record = this.coordinator.storeWelcome({
  targetStablePubkey: input.target_pk,
  keyPackageReference: input.kp_ref,
  welcome: decodeWelcomeBase64(input.welcome_64),
  joinAfterCursor: input.after,
});
```

In [`CoordinatorAdapter.fetchPendingWelcomes()`](../src/server/coordinatorMethods.ts:476):

```ts
welcomes: records.map((record) => ({
  kp_ref: record.keyPackageReference,
  welcome_64: encodeWelcomeBase64(record.welcome),
  at: record.createdAt,
  after: record.joinAfterCursor,
}))
```

## Storage Plan

### In-memory storage

[`InMemoryCoordinatorStorage.storeWelcome()`](../src/coordinator/storage/inMemoryStorage.ts:106) already copies the full record:

```ts
const stored: WelcomeQueueRecord = { ...record };
```

After type updates, it preserves `joinAfterCursor` automatically.

Group message storage should be simplified to no longer require or filter by `epoch`.

### SQLite storage

Add a Welcome cursor hint column:

```sql
ALTER TABLE welcomes ADD COLUMN join_after_cursor INTEGER;
```

Migration pattern near the existing `read_at` migration in [`sqliteStorage.ts`](../src/coordinator/storage/sqliteStorage.ts:252):

```ts
const welcomesColumns = this.database
  .prepare("PRAGMA table_info('welcomes')")
  .all() as Array<{ name: string }>;

if (!welcomesColumns.some((col) => col.name === "join_after_cursor")) {
  this.database.exec(
    "ALTER TABLE welcomes ADD COLUMN join_after_cursor INTEGER",
  );
}
```

Update row mapping:

```ts
interface WelcomeRow {
  target_stable_pubkey: string;
  key_package_reference: string;
  welcome_bytes: Buffer;
  join_after_cursor: number | null;
  created_at: number;
  read_at: number | null;
}

private mapWelcomeRow(row: WelcomeRow): WelcomeQueueRecord {
  return {
    targetStablePubkey: row.target_stable_pubkey,
    keyPackageReference: row.key_package_reference,
    welcome: decodeWelcome(toUint8Array(row.welcome_bytes)),
    joinAfterCursor: row.join_after_cursor ?? undefined,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}
```

For group messages, clean-cut behavior should stop using epoch filters. To avoid risky destructive migrations in the same iteration, existing SQLite columns may remain physically present but should become unused:

- `group_messages.epoch`
- `group_routing.latest_handshake_epoch`

Later, a storage schema cleanup can drop or rebuild those tables.

## CLI Plan

### Posting group messages

All call sites for `PostGroupMessage` must supply outer `gid`.

Current send flow in [`sendMessage()`](../src/cli/session.ts:595) should derive the delivery `gid` from group session state and include it:

```ts
const groupId = this.deriveGroupId(group.state);

const posted = await this.getGroupClient(group).PostGroupMessage({
  gid: groupId,
  msg_64: outbound.opaqueMessageBase64,
});
```

When Marmot-style encryption is introduced, `outbound.opaqueMessageBase64` becomes encrypted `base64(nonce || ciphertext)` rather than raw MLS bytes.

### Add-member flow

When the Commit adding a member is posted, capture its cursor:

```ts
const postedCommit = await client.PostGroupMessage({
  gid: groupId,
  msg_64: commitMessageBase64,
});

pendingOperation.joinAfterCursor = postedCommit.cursor;
```

Then [`pendingEpochOperations.ts`](../src/cli/pendingEpochOperations.ts) stores the Welcome with:

```ts
await context.client.StoreWelcome({
  target_pk: operation.targetStablePubkey,
  kp_ref: operation.keyPackageReference,
  welcome_64: operation.welcomeBase64,
  after: operation.joinAfterCursor,
});
```

### Accept Welcome

In [`acceptWelcome()`](../src/cli/session.ts:560), initialize cursor from the fetched Welcome before baseline sync:

```ts
const initialFetchCursor = welcome.after ?? 0;
group.fetchCursor = Math.max(group.fetchCursor, initialFetchCursor);
```

Then [`establishPostWelcomeBaseline()`](../src/cli/session.ts:970) naturally fetches only messages after the join boundary.

## Clean Cut: Remove `sinceEpoch`

The new model should remove `sinceEpoch` rather than keeping both paths.

Remove from:

- [`fetchGroupMessagesInputSchema`](../src/contracts/index.ts:151)
- [`FetchGroupMessagesInput`](../src/coordinator/types.ts:68)
- [`CoordinatorAdapter.fetchGroupMessages()`](../src/server/coordinatorMethods.ts:629)
- [`CoordinatorAdapter.fetchManyGroupMessages()`](../src/server/coordinatorMethods.ts:647)
- [`CoordinatorAdapter.subscribeGroupMessages()`](../src/server/coordinatorMethods.ts:668)
- [`CoordinatorAdapter.subscribeManyGroupMessages()`](../src/server/coordinatorMethods.ts)
- in-memory storage filtering
- SQLite epoch-filtering statements
- tests asserting `since_epoch` behavior

Delete helper code such as `parseSinceEpoch()` if it becomes unused.

## Blast Radius

### Required changes

- [`src/contracts/index.ts`](../src/contracts/index.ts)
- [`src/coordinator/types.ts`](../src/coordinator/types.ts)
- [`src/coordinator/coordinator.ts`](../src/coordinator/coordinator.ts)
- [`src/coordinator/storage/storage.ts`](../src/coordinator/storage/storage.ts)
- [`src/coordinator/storage/inMemoryStorage.ts`](../src/coordinator/storage/inMemoryStorage.ts)
- [`src/coordinator/storage/sqliteStorage.ts`](../src/coordinator/storage/sqliteStorage.ts)
- [`src/server/coordinatorMethods.ts`](../src/server/coordinatorMethods.ts)
- [`src/cli/coordinatorClient.ts`](../src/cli/coordinatorClient.ts)
- [`src/cli/session.ts`](../src/cli/session.ts)
- [`src/cli/membershipFlow.ts`](../src/cli/membershipFlow.ts)
- [`src/cli/pendingEpochOperations.ts`](../src/cli/pendingEpochOperations.ts)
- [`src/cli/utils/mlsMessages.ts`](../src/cli/utils/mlsMessages.ts) once payload encryption is implemented
- tests under [`src/coordinator/`](../src/coordinator/), [`src/server/`](../src/server/), and [`src/cli/`](../src/cli/)

### Likely removals

- MLS decoder imports from coordinator code
- `epoch` field from public group-message records
- `latestHandshakeEpoch` public routing behavior
- stale-handshake coordinator warning logs
- `since_epoch` contracts and tests
- SQLite `fetchGroupMessagesSinceEpoch*` statements
- in-memory `sinceEpoch` filtering branches

### Schema compatibility

Use additive migration for `welcomes.join_after_cursor` to avoid regressions.

Do not destructively remove old `epoch` columns in the same iteration unless the SQLite migration is carefully tested. Prefer logical cleanup first, physical schema cleanup later.

## Regression Analysis

### Privacy regressions to avoid

- Do not decode encrypted MLS payloads in coordinator code.
- Do not derive group routing from encrypted MLS bytes.
- Do not reintroduce `since_epoch` as a hidden server-side optimization.
- Do not require outer `gid` to match inner MLS `group_id`.
- Do not expose `epoch`, `wireformat`, or `contentType` in coordinator responses.

### Functional regressions to avoid

- Per-group cursors must remain monotonic and scoped per group.
- Fetch with `after` must remain bounded and cursor-only.
- Subscribe backlog replay must use `after` only.
- Multi-group fetch/subscribe must preserve independent per-group cursors.
- Welcome fetch must remain non-destructive.
- Welcome `after` must survive both in-memory and SQLite backends.
- Old welcomes without `after` must still work by falling back to cursor `0`.

### Security regressions to avoid

- Clients must perform all MLS validation locally.
- Clients must reject undecryptable or invalid messages during sync without corrupting state.
- Clients must not finalize pending epoch operations before outbound Commit confirmation; preserve the CLI flow documented in [`src/cli/README.md`](../src/cli/README.md:54).
- Clients must handle wrong-topic messages gracefully. Because outer `gid` and inner MLS group ID are intentionally decoupled, a message posted to a delivery topic may fail decryption or MLS validation; clients should treat it as an invalid/unprocessable message for that local group state.

## Test Plan

### Coordinator tests

Add tests in [`src/coordinator/coordinator.test.ts`](../src/coordinator/coordinator.test.ts):

```ts
const posted = coordinator.postGroupMessage({
  groupId: "delivery-topic",
  ephemeralSenderPubkey: "sender",
  opaqueMessage: encryptedBytes,
});

expect(posted.groupId).toBe("delivery-topic");
```

Add a Welcome hint round-trip:

```ts
coordinator.storeWelcome({
  targetStablePubkey: bob.actor.stablePubkey,
  keyPackageReference: kpRef,
  welcome,
  joinAfterCursor: 42,
});

expect(coordinator.fetchPendingWelcomes(bob.actor.stablePubkey)[0]).toEqual(
  expect.objectContaining({ joinAfterCursor: 42 }),
);
```

### Storage parity tests

Update [`src/coordinator/storage/storage.test.ts`](../src/coordinator/storage/storage.test.ts) so both backends verify:

- opaque group messages store without MLS decoding
- `joinAfterCursor` round-trips
- fetch ignores epochs because epochs no longer exist as a fetch predicate

### Server tests

Update [`src/server/coordinatorServer.test.ts`](../src/server/coordinatorServer.test.ts):

```ts
const posted = adapter.postGroupMessage(
  { gid: "delivery-topic", msg_64: encryptedMessageBase64 },
  extra,
);

expect(posted.structuredContent.gid).toBe("delivery-topic");
```

Welcome hint contract:

```ts
adapter.storeWelcome({
  target_pk: bobPk,
  kp_ref: kpRef,
  welcome_64,
  after: 42,
});

expect(adapter.fetchPendingWelcomes({}, extra).structuredContent.welcomes[0])
  .toMatchObject({ after: 42 });
```

### CLI integration regression

Add a scenario in [`src/cli/session.integration.test.ts`](../src/cli/session.integration.test.ts):

```text
Alice creates group
Alice sends pre-join message A
Alice adds Bob; add-member Commit is posted at cursor C
Welcome stored for Bob with after=C
Alice sends post-join message B
Bob accepts Welcome
Bob syncs
Bob receives B, not A
Bob's group fetchCursor starts at C
```

This proves `welcome.after` replaces `since_epoch` for efficient advanced-epoch joins.

## Suggested Implementation Order

1. Add `gid` to `PostGroupMessage` contract and propagate through server/client calls.
2. Make coordinator posting use caller-supplied `groupId` and stop decoding MLS for routing.
3. Remove `since_epoch` from contracts, adapters, storage queries, and tests.
4. Add `joinAfterCursor` / `after` to Welcome contracts, coordinator types, storage, and adapters.
5. Update CLI add-member flow to store `after = postedCommit.cursor`.
6. Update CLI accept-Welcome flow to initialize `fetchCursor` from `welcome.after ?? 0`.
7. Add/update regression tests.
8. Run targeted tests:
   - `pnpm exec vitest run src/coordinator/coordinator.test.ts`
   - `pnpm exec vitest run src/coordinator/storage/storage.test.ts`
   - `pnpm exec vitest run src/server/coordinatorServer.test.ts`
   - `pnpm exec vitest run src/cli/session.integration.test.ts`
9. Run `pnpm run typecheck`.

## Summary

The next iteration should make this clean conceptual cut:

```text
Coordinator-visible:
  outer delivery gid
  per-group cursor
  opaque encrypted payload bytes
  Welcome join-after cursor hint

Client-only:
  MLS group ID
  MLS epoch
  MLS wireformat
  MLS content type
  sender identity
  application message contents
```

The efficient join problem does not require epoch-aware coordinators. It only requires the inviter to pass the invitee a coordinator cursor boundary. `welcome.after` bridges client MLS state and coordinator cursor state without exposing MLS metadata to the coordinator.
