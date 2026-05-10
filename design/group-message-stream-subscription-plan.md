# Group Message Stream Subscription Plan

## Summary

We want to add a new server method for group message subscription using CEP-41 open-ended streams from [`@contextvm/sdk`](package.json:32), while preserving the current fetch-based API in [`fetch_group_messages`](src/contracts/index.ts:21) and the current coordinator cursor semantics in [`fetchGroupMessages()`](src/coordinator/coordinator.ts:171).

The goal is to improve UX for active clients by allowing real-time message delivery without polling, while keeping the implementation minimal, consistent, and low-risk.

## Current baseline

Today the server exposes bounded fetch semantics through [`CONTEXTVM_COORDINATOR_TOOLS.fetchGroupMessages`](src/contracts/index.ts:21), registered in [`src/server/coordinatorMethods.ts`](src/server/coordinatorMethods.ts:415).

That existing API should remain fully supported and continue to be the canonical bounded catch-up mechanism.

Important current invariants:

- group message cursors are monotonic per group, not global
- [`afterCursor`](src/contracts/index.ts:108) is interpreted relative to the specified `groupId`
- storage backends remain the durable source of truth for queued group messages

These semantics are already reflected in [`README.md`](README.md:14) and [`AGENTS.md`](AGENTS.md:17), and the new streaming method should align with them rather than introduce a parallel model.

## Proposed API shape

Add a new server tool for subscribing to group messages via CEP-41.

Working name candidates:

- `subscribe_group_messages`
- `stream_group_messages`

Preferred direction: `subscribe_group_messages`, because the primary user-facing intent is active subscription, even though the transport is stream-based.

### Input

The new method should mirror [`fetchGroupMessagesInputSchema`](src/contracts/index.ts:106) as closely as possible:

- `groupId`
- optional `afterCursor`

This keeps the API consistent and preserves one cursor mental model across bounded fetch and open-ended subscribe.

### Streamed item shape

Each CEP-41 progress notification should carry exactly one group message record, and that record should match [`groupMessageSchema`](src/contracts/index.ts:111) as closely as possible.

Target streamed fields:

- `cursor`
- `groupId`
- `opaqueMessageBase64`
- `createdAt`

Non-goals:

- no extra `kind` discriminator
- no separate stream-only record shape
- no batch envelope containing multiple messages for the initial implementation

This gives one unified data model:

- [`fetchGroupMessages()`](src/coordinator/coordinator.ts:171) returns an array of group message records
- subscription emits one group message record at a time

## Subscription semantics

The subscription method should support **backlog plus live delivery**.

That means:

1. the client provides `groupId` and optionally `afterCursor`
2. the server replays any queued messages after that cursor, one streamed message per progress notification
3. the server then keeps the stream open and emits new matching messages as they arrive

This avoids an unnecessary “live-only” limitation and also closes the race window between catch-up and steady-state subscription.

Even so, the recommended client strategy remains:

1. use [`fetchGroupMessages()`](src/coordinator/coordinator.ts:171) first for efficient bounded catch-up
2. then start the subscription from the freshest known cursor

The subscription method still supports backlog replay because that is useful for correctness, flexibility, and reconnect behavior, even if it is not always the most efficient way to catch up.

## Transport model

This design intentionally uses the two ContextVM transport capabilities according to their strengths:

- bounded catch-up uses the existing fetch tool and can automatically benefit from CEP-22 oversized transfer behavior described in [`docs/os-transfers.md`](docs/os-transfers.md:8)
- open-ended live delivery uses CEP-41 streams as described in [`docs/cep-41-ts-sdk.md`](docs/cep-41-ts-sdk.md:51)

This gives a clean transport layering:

- CEP-22 for large bounded responses
- CEP-41 for incremental open-ended delivery

## Server-side architecture

### Core principle

Keep durable message semantics in the existing coordinator and storage path, and add only a small in-memory live fanout layer for active subscriptions.

### What should remain unchanged

The following should remain the durable source of truth:

- [`src/coordinator/storage/inMemoryStorage.ts`](src/coordinator/storage/inMemoryStorage.ts)
- [`src/coordinator/storage/sqliteStorage.ts`](src/coordinator/storage/sqliteStorage.ts)
- [`fetchGroupMessages()`](src/coordinator/coordinator.ts:171)

We do **not** want to persist subscriptions or push stream-specific state into storage backends.

### Live fanout model

Use a simple in-memory per-group subscriber registry.

Recommended structure:

- `Map<groupId, Set<subscriber>>`
- one lightweight async queue per subscriber
- publish to that registry only after [`postGroupMessage()`](src/coordinator/coordinator.ts:140) has successfully appended the message

Each subscriber queue should support a minimal lifecycle:

- `push(value)`
- `close()`
- `abort(error)`
- async iteration via [`Symbol.asyncIterator`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncIterator)

This is intentionally simple and avoids building a more abstract event bus.

### Why async iterators

Async iterators are the best fit on the server side because they align naturally with the CEP-41 writer pattern in [`docs/cep-41-ts-sdk.md`](docs/cep-41-ts-sdk.md:148).

The stream tool can naturally:

1. fetch backlog from [`fetchGroupMessages()`](src/coordinator/coordinator.ts:171)
2. emit each backlog message individually
3. iterate the live subscriber queue with `for await`
4. write each new item through [`OpenStreamWriter.write()`](docs/cep-41-ts-sdk.md:265)

This is small, readable, and consistent.

### Ordering and duplicate suppression

The subscription handler should track `lastEmittedCursor`.

Rules:

- emit backlog messages in cursor order
- when transitioning to live messages, only emit records with `cursor > lastEmittedCursor`
- use per-group cursor monotonicity as the unifying rule

This handles overlap cleanly when backlog replay and live fanout meet.

## Scalability stance

We explicitly choose the simplest correct fanout design first.

### Accepted cost model

For a message delivered to `N` subscribers of one group, some form of `O(N)` work is unavoidable because each subscriber ultimately needs its own CEP-41 stream write and lifecycle handling.

The goal is not to remove `O(N)` entirely, but to keep the per-subscriber work small and isolated.

### Chosen approach

Use per-group fanout with per-subscriber bounded queues.

Optimization guidelines:

- push the same normalized message object/reference to all subscriber queues when possible
- avoid re-encoding or reshaping per subscriber
- evict slow or unhealthy subscribers quickly
- rely on fetch-based recovery for clients that fall behind

### Deferred optimizations

The following are intentionally out of scope for the first implementation:

- cohorting subscribers by cursor height
- shared live pools with subscriber handoff
- durable subscription persistence
- server-side ack protocols
- message batching into one progress notification
- generic event bus abstractions

These ideas may be revisited later if real-world measurements justify them, but they add substantial complexity and are not necessary for the first version.

## Client-side architecture

Client code should also use async iterators.

### Low-level streaming primitive

The subscription helper should use [`callToolStream()`](docs/cep-41-ts-sdk.md:53) and parse each stream chunk as a [`groupMessageSchema`](src/contracts/index.ts:111) record.

This naturally exposes an `AsyncIterable<GroupMessage>` style interface.

### Recommended client flow

For robust synchronization:

1. call [`FetchGroupMessages`](src/cli/coordinatorClient.ts:59) from the latest stored cursor
2. process returned messages and advance local cursor
3. call the new subscription method with the refreshed cursor
4. process one streamed message at a time
5. on disconnect or abort, reconnect and repeat the same flow

This keeps the client recovery model explicit and efficient.

### Ergonomics direction

- low-level: `SubscribeGroupMessages`
- convenience helper: fetch first, then subscribe, exposed as one async iterable sequence

This keeps protocol concerns and ergonomic helpers separate.

## Error handling and cleanup

Important lifecycle requirements:

- remove subscribers from the registry on disconnect
- remove subscribers on stream abort
- remove subscribers on write failure
- keep subscriber buffering bounded
- if a subscriber cannot keep up, fail the stream and let the client recover using fetch plus resubscribe

This is one of the main reasons the simple per-subscriber queue design is attractive: cleanup and isolation remain straightforward.

## Testing plan

### Server behavior

Add targeted coverage around the new subscription method in or near [`src/server/coordinatorServer.test.ts`](src/server/coordinatorServer.test.ts):

- backlog replay after `afterCursor`
- live delivery after subscription starts
- duplicate suppression across backlog/live boundary
- filtering by `groupId`
- cleanup on abort/disconnect

### Client/transport integration

Add integration coverage using CEP-41 via [`callToolStream()`](docs/cep-41-ts-sdk.md:53):

- stream yields one message record per progress notification
- stream payload matches [`groupMessageSchema`](src/contracts/index.ts:111)
- final tool result resolves independently from the stream

### Regression coverage

Existing fetch behavior must remain unchanged and continue to be covered by current tests around [`fetchGroupMessages()`](src/coordinator/coordinator.ts:171).

## Likely implementation touchpoints

Expected main files:

- [`src/contracts/index.ts`](src/contracts/index.ts) for new tool name and schemas
- [`src/server/coordinatorMethods.ts`](src/server/coordinatorMethods.ts:415) for new tool registration and streaming handler
- [`src/server/coordinatorServer.ts`](src/server/coordinatorServer.ts:47) and/or [`src/server/main.ts`](src/server/main.ts) to ensure CEP-41 open stream support is enabled
- [`src/coordinator/coordinator.ts`](src/coordinator/coordinator.ts:81) for a small live subscription hub or hook point
- [`src/cli/coordinatorClient.ts`](src/cli/coordinatorClient.ts:119) for client subscription helpers

## Final design decisions captured here

- keep [`fetchGroupMessages()`](src/coordinator/coordinator.ts:171) as the canonical bounded catch-up API
- add a new CEP-41-backed subscription tool
- keep streamed message payload identical to [`groupMessageSchema`](src/contracts/index.ts:111)
- emit one progress notification per message
- support backlog plus live delivery in the subscription method
- recommend `fetch first, then subscribe` for efficient client catch-up
- use async iterators on both server and client
- use a simple in-memory per-group fanout with per-subscriber bounded queues
- avoid premature shared-pool or cohort optimizations
- keep storage backends unchanged

## Next iteration scope

The next implementation iteration should convert this plan into:

1. exact tool naming
2. concrete input/output schemas
3. coordinator-side subscription primitives
4. server handler implementation
5. client helper implementation
6. targeted tests
7. documentation updates in [`README.md`](README.md:1) and [`AGENTS.md`](AGENTS.md:1)
