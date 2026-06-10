# Join Requests Design Document

- Status: Design Plan
- Purpose: Support shareable group links for easier onboarding

## Problem Statement

The current MLS join flow in [`cordn`](../package.json) requires an existing group member to proactively add a new user. This creates friction for shareable group links where:

1. A user discovers a group via a shareable link (e.g., `https://cordn.net/chat/<group-id>`)
2. The user wants to request to join
3. Existing members should be able to review and approve the request

The coordinator needs a mechanism for users to signal join intent, and for members to discover and process those requests.

## Design Principles

1. **Welcome Symmetry**: Join requests are the inverse of Welcomes. Mirror the existing Welcome pattern exactly.
2. **Minimal Coordinator**: Keep the coordinator as a delivery service, not a group manager.
3. **MLS Compliance**: Preserve MLS semantics — members still create Add+Commit locally.
4. **Consistency**: Follow existing patterns for validation, cleanup, and error handling.

## Core Design

### Direction and Keying

| | Welcome (existing) | Join Request (new) |
|---|---|---|
| **Direction** | Member → Target identity | Requester → Group |
| **Keyed by** | `targetStablePubkey` | `groupId` |
| **Store** | [`storeWelcome()`](../src/coordinator/coordinator.ts:257) | `storeJoinRequest()` |
| **Fetch** | [`fetchPendingWelcomes()`](../src/coordinator/coordinator.ts:269) | `fetchPendingJoinRequests()` |
| **Cleanup** | [`deleteExpiredWelcomes()`](../src/coordinator/coordinator.ts:273) | `deleteExpiredJoinRequests()` |
| **Lifecycle** | `readAt` set on fetch, TTL-deleted after read | `readAt` set on fetch, TTL-deleted after read |

### Types

New types in [`src/coordinator/types.ts`](../src/coordinator/types.ts):

```typescript
// Mirrors WelcomeQueueRecord
export interface JoinRequestRecord {
  groupId: string;
  requesterStablePubkey: string;
  keyPackageRef: string;
  createdAt: number;
  readAt: number | null;
}

// Mirrors StoreWelcomeInput
export interface StoreJoinRequestInput {
  groupId: string;
  keyPackageRef: string;
}
```

### Coordinator Methods

New methods on [`Coordinator`](../src/coordinator/coordinator.ts:196):

```typescript
storeJoinRequest(input: StoreJoinRequestInput): JoinRequestRecord;
fetchPendingJoinRequests(groupId: string): JoinRequestRecord[];
deleteExpiredJoinRequests(threshold: number): number;
```

**`storeJoinRequest`**:
- Creates a record with `readAt: null`
- Validates group exists, KP exists, and caller owns the KP
- Deduplicates: one unread request per `(groupId, requesterStablePubkey)`

**`fetchPendingJoinRequests`**:
- Returns all requests for the group
- Marks unread requests with `readAt = now` (same as [`fetchPendingWelcomes()`](../src/coordinator/coordinator.ts:269))

**`deleteExpiredJoinRequests`**:
- Deletes requests where `readAt !== null && readAt < threshold`
- Called by the existing cleanup timer alongside [`deleteExpiredWelcomes()`](../src/coordinator/coordinator.ts:273)

### Storage Interface

New methods on [`CoordinatorStorage`](../src/coordinator/storage/storage.ts:35):

```typescript
storeJoinRequest(record: JoinRequestRecord): JoinRequestRecord;
fetchPendingJoinRequests(groupId: string, now: number): JoinRequestRecord[];
deleteExpiredJoinRequests(threshold: number): number;
```

Both [`InMemoryCoordinatorStorage`](../src/coordinator/storage/inMemoryStorage.ts:33) and [`SqliteCoordinatorStorage`](../src/coordinator/storage/sqliteStorage.ts) implement these with parity coverage in [`storage.test.ts`](../src/coordinator/storage/storage.test.ts).

### Contracts

New in [`src/contracts/index.ts`](../src/contracts/index.ts):

```typescript
export const COORDINATOR_METHODS = {
  // ... existing methods
  storeJoinRequest: "join_request_store",
  fetchPendingJoinRequests: "join_request_take",
} as const;

export const storeJoinRequestInputSchema = z.object({
  gid: z.string().min(1),
  kp_ref: z.string().min(1),
});

export const storeJoinRequestOutputSchema = z.object({
  at: z.number(),
});

export const joinRequestSchema = z.object({
  pk: z.string(),
  kp_ref: z.string(),
  at: z.number(),
});

export const fetchPendingJoinRequestsInputSchema = z.object({
  gid: z.string().min(1),
});

export const fetchPendingJoinRequestsOutputSchema = z.object({
  requests: z.array(joinRequestSchema),
});
```

Naming follows the existing `welcome_store` / `welcome_take` convention.

### Server Authorization

In [`src/server/coordinatorMethods.ts`](../src/server/coordinatorMethods.ts):

**`storeJoinRequest`**:
- Requires `clientPubkey`
- Validates:
  1. Group exists: `getGroupRouting(gid) !== null`
  2. KP exists: `getKeyPackage(kp_ref) !== null`
  3. KP ownership: `getKeyPackage(kp_ref)?.stablePubkey === clientPubkey`
- Rate-limited

**`fetchPendingJoinRequests`**:
- No identity check (mirrors [`fetchGroupMessages`](../src/server/coordinatorMethods.ts:549))
- Rate-limited only

## Validation Rules

### At `storeJoinRequest` Time

| Case | Error | Rationale |
|---|---|---|
| Group doesn't exist in coordinator | `"Group not found"` | Prevents bogus requests to non-existent groups |
| `kp_ref` not found in coordinator | `"Unknown key package ref"` | The referenced KP doesn't exist or was already consumed/removed |
| `kp_ref` exists but `stablePubkey` doesn't match caller | `"Unauthorized key package ref"` | Prevents impersonation — caller must own the KP |
| Duplicate request (same `groupId` + `requesterStablePubkey` already unread) | Silently return existing record | Idempotent — no error, just dedup |
| `kp_ref` is a last-resort KeyPackage | **Allow it** | Last-resort KPs aren't consumed on retrieval, so they remain available |

### At Member Processing Time (Client-Side)

These are **not coordinator errors** — they're client-side handling when a member acts on a fetched request:

| Case | Client Behavior |
|---|---|
| `consumeKeyPackage({ id: kp_ref })` returns `null` | KP was consumed by another operation or removed. Member skips this request. |
| Two members both fetch the same request and both try to consume the KP | Only one `consumeKeyPackage` succeeds; the other gets `null` and skips. Natural race resolution. |
| Member creates Add+Commit but `postGroupMessage` fails | Member retries posting. The join request is already marked `readAt`, so it won't reappear. Member should track this as a pending epoch operation. |
| Member processes request but requester was already added by another member | The Add+Commit will fail MLS validation on other members' devices (duplicate leaf). MLS-level conflict, not a coordinator concern. |

## Edge Cases

### KeyPackage Consumed by Unrelated Group

The requester's KP could be consumed by someone adding them to a *different* group. The join request then references a stale `kp_ref`. When a member tries to consume it, they get `null` and skip. The requester must publish a new KP and submit a new request. This is acceptable — KPs are inherently one-time-use resources.

### Request TTL Expires Before Processing

The cleanup timer deletes it (same as Welcomes). The requester submits a new request. No coordinator complexity.

### Requester Wants to Update KP on Pending Request

They publish a new KP and call `storeJoinRequest` again with the new `kp_ref`. Since the old request is already read (has `readAt` set), the dedup check only applies to *unread* requests. The new request replaces the old one naturally. If the old request is still unread, the dedup returns the existing record — the requester would need to wait for it to be read or expire.

### Group Doesn't Exist

The coordinator validates group existence at `storeJoinRequest` time via `getGroupRouting(gid) !== null`. This prevents orphaned requests to non-existent groups. A group "exists" in the coordinator DB once at least one message has been posted to it.

### Request Spam

A malicious user could flood a group with join requests. Mitigations already in place:
- Existing [`TokenBucketRateLimiter`](../src/server/rateLimit.ts) limits call frequency
- Deduplication prevents the same user from creating multiple unread requests
- Per-identity quota (similar to [`enforceKeyPackageQuota()`](../src/server/coordinatorMethods.ts:286)) could limit total pending requests per requester

## Processing Flow

```
1. New user publishes a KeyPackage (existing flow)
2. New user calls: storeJoinRequest({ gid: "<group-id>", kp_ref: "<their-kp-ref>" })
3. Group member calls: fetchPendingJoinRequests({ gid: "<group-id>" })
4. Member sees request, calls: consumeKeyPackage({ id: kp_ref })
5. Member creates Add+Commit locally via addMemberToGroup()
6. Member calls: postGroupMessage() with the Commit
7. Member calls: storeWelcome() for the new user
8. New user calls: fetchPendingWelcomes() and joins via the Welcome
```

The join request is automatically cleaned up after being read (TTL), exactly like Welcomes.

## Cleanup Timer Extension

The existing cleanup timer in [`Coordinator`](../src/coordinator/coordinator.ts:205) extends to also call `deleteExpiredJoinRequests()` with the same threshold and interval. No new timer needed.

## Implementation Plan

### Files to Modify

1. **[`src/coordinator/types.ts`](../src/coordinator/types.ts)**
   - Add `JoinRequestRecord` interface
   - Add `StoreJoinRequestInput` interface

2. **[`src/coordinator/coordinator.ts`](../src/coordinator/coordinator.ts)**
   - Add `storeJoinRequest()` method
   - Add `fetchPendingJoinRequests()` method
   - Add `deleteExpiredJoinRequests()` method
   - Extend cleanup timer to call `deleteExpiredJoinRequests()`

3. **[`src/coordinator/storage/storage.ts`](../src/coordinator/storage/storage.ts)**
   - Add storage interface methods

4. **[`src/coordinator/storage/inMemoryStorage.ts`](../src/coordinator/storage/inMemoryStorage.ts)**
   - Implement in-memory storage methods
   - Add `joinRequestsByGroup` map

5. **[`src/coordinator/storage/sqliteStorage.ts`](../src/coordinator/storage/sqliteStorage.ts)**
   - Add `join_requests` table schema
   - Implement SQLite storage methods

6. **[`src/coordinator/storage/storage.test.ts`](../src/coordinator/storage/storage.test.ts)**
   - Add parity test coverage for both backends

7. **[`src/contracts/index.ts`](../src/contracts/index.ts)**
   - Add Zod schemas
   - Add method names to `COORDINATOR_METHODS`

8. **[`src/server/coordinatorMethods.ts`](../src/server/coordinatorMethods.ts)**
   - Add server method implementations
   - Add validation logic
   - Register tools with `registerCoordinatorMethods()`

### Testing Strategy

- Unit tests for storage backends (parity coverage)
- Unit tests for coordinator methods
- Integration tests for server methods
- Edge case tests for validation rules
- Race condition tests for concurrent consumption

## Rationale

This design keeps the coordinator minimal and uniform while enabling the shareable link use case. The client-side logic (in the web app) handles the UX of generating links, displaying pending requests, and processing them.

The design is resilient because:
- The coordinator stays stateless about group membership — consistent with [`spec/00.md`](../spec/00.md)
- KeyPackage consumption races resolve naturally — one consumer wins, others get `null`
- TTL cleanup handles all orphaned state — no manual cancellation needed
- All validation happens at store time — the coordinator rejects bad requests early
- Client-side failures are recoverable — members can retry, requesters can re-request
