# Cordn Join Requests

- Status: Draft

## Abstract

This document defines the `cordn` join request mechanism for [`cordn`](package.json). Join requests are the inverse of Welcomes: they allow users to signal intent to join a group, while Welcomes allow existing members to invite new users. The coordinator provides a minimal delivery service for join requests, mirroring the existing Welcome queue pattern.

Join requests enable shareable group links where a user discovers a group, publishes a KeyPackage, and submits a join request. Existing group members fetch pending requests, consume the requester's KeyPackage, create an Add+Commit locally, and complete the join by posting the Commit and storing a Welcome for the new member.

This document specifies the coordinator protocol surface for join requests. Client-side MLS processing, group membership validation, and user experience are out of scope.

## Specification

### 1. Overview

`cordn` join requests provide a coordinator-mediated signaling mechanism for group join intent.

- Join requests are stored per group, keyed by `groupId`.
- Join requests mirror the Welcome queue pattern.
- The coordinator does not manage group membership or MLS state.
- Clients are responsible for consuming KeyPackages, creating Add+Commits, and completing the join flow.

This document defines only the coordinator protocol surface. Application-level UX, link generation, and request review interfaces are out of scope.

### 2. Direction and Keying

Join requests are the inverse of Welcomes.

| | Welcome | Join Request |
|---|---|---|
| **Direction** | Member → Target identity | Requester → Group |
| **Keyed by** | `targetStablePubkey` | `groupId` |
| **Store** | `storeWelcome()` | `storeJoinRequest()` |
| **Fetch** | `fetchPendingWelcomes()` | `fetchPendingJoinRequests()` |
| **Cleanup** | `deleteExpiredWelcomes()` | `deleteExpiredJoinRequests()` |
| **Lifecycle** | `readAt` set on fetch, TTL-deleted after read | `readAt` set on fetch, TTL-deleted after read |

This symmetry ensures consistent coordinator behavior and simplifies implementation.

### 3. Types

Join requests use the following record and input types.

```typescript
export interface JoinRequestRecord {
  groupId: string;
  requesterStablePubkey: string;
  keyPackageRef: string;
  createdAt: number;
  readAt: number | null;
}

export interface StoreJoinRequestInput {
  groupId: string;
  keyPackageRef: string;
}
```

The `JoinRequestRecord` mirrors [`WelcomeQueueRecord`](../src/coordinator/types.ts:13) with group-scoped keying instead of identity-scoped keying.

### 4. Coordinator Methods

Coordinators MUST implement the following join request methods.

```typescript
storeJoinRequest(input: StoreJoinRequestInput): JoinRequestRecord;
fetchPendingJoinRequests(groupId: string): JoinRequestRecord[];
fetchManyPendingJoinRequests(input: { groups: { groupId: string }[] }): JoinRequestRecord[];
deleteExpiredJoinRequests(readThreshold: number, unreadThreshold: number): number;
```

#### 4.1 `storeJoinRequest`

Creates a join request record with `readAt: null`.

Validation requirements:

- The KeyPackage MUST exist in coordinator storage (verified via `getKeyPackage(keyPackageRef) !== null`).
- The caller MUST own the KeyPackage (verified via `getKeyPackage(keyPackageRef)?.stablePubkey === callerIdentity`).

Group existence is intentionally NOT validated. The coordinator is a signaling service and does not require a group to have message history before accepting join requests. This allows freshly created groups with no messages to accept join requests immediately (the "bootstrap" scenario). Per-group caps on pending join requests and existing rate limiting bound storage abuse from non-existent group IDs.

Deduplication behavior:

- If an unread request already exists for the same `(groupId, requesterStablePubkey)`, the coordinator MUST return the existing record without error.
- This provides idempotent store semantics for unread requests.

Last-resort KeyPackages:

- Coordinators MUST accept last-resort KeyPackages for join requests.
- Last-resort KeyPackages are not consumed on retrieval, so they remain available for multiple join attempts.

#### 4.2 `fetchPendingJoinRequests`

Returns all join requests for the specified group.

Read-tracking behavior:

- The coordinator MUST set `readAt = now` for all unread requests in the returned set.
- This mirrors the read-tracking behavior of [`fetchPendingWelcomes()`](../src/coordinator/coordinator.ts:266).

The method returns requests in storage order. Clients are responsible for filtering, sorting, or paginating as needed.

#### 4.2b `fetchManyPendingJoinRequests`

Returns all join requests for multiple groups in a single call.

Input schema:

```typescript
{ groups: { groupId: string }[] }
```

Read-tracking behavior:

- The coordinator MUST set `readAt = now` for all unread requests across all requested groups atomically before returning results.
- This mirror the read-tracking behavior of [`fetchPendingJoinRequests()`](#42-fetchpendingjoinrequests) but applied across all requested groups in a single transaction.

The method returns requests ordered by input group order, then storage order within each group. Each returned record carries its `groupId` so clients can distinguish which group a request belongs to.

Results from groups with no pending requests are simply omitted from the output; the method never errors for non-existent or empty groups.

#### 4.3 `deleteExpiredJoinRequests`

Deletes join requests that exceed expiration thresholds.

Expiration rules:

- Requests with `readAt !== null` are deleted when `readAt < readThreshold`.
- Requests with `readAt === null` are deleted when `createdAt < unreadThreshold` and `unreadThreshold > 0`.
- When `unreadThreshold === 0`, unread requests are never deleted by age.

This dual-threshold model allows operators to configure aggressive cleanup for read requests while preserving unread requests for longer periods.

The method returns the count of deleted requests.

### 5. Storage Interface

Storage backends MUST implement the following methods.

```typescript
storeJoinRequest(record: JoinRequestRecord): JoinRequestRecord;
fetchPendingJoinRequests(groupId: string, now: number): JoinRequestRecord[];
fetchManyPendingJoinRequests(input: { groups: { groupId: string }[] }, now: number): JoinRequestRecord[];
deleteExpiredJoinRequests(readThreshold: number, unreadThreshold: number): number;
```

Both in-memory and SQLite storage backends MUST provide parity coverage for these methods.

#### 5.1 In-Memory Storage

In-memory implementations store join requests in a group-keyed map.

- `storeJoinRequest` appends to the group's request list after deduplication.
- `fetchPendingJoinRequests` returns all requests for the group and sets `readAt` for unread entries.
- `fetchManyPendingJoinRequests` delegates to `fetchPendingJoinRequests` per group and flattens results. Ordering follows input group order.
- `deleteExpiredJoinRequests` filters the global request set using both thresholds in a single pass.

#### 5.2 SQLite Storage

SQLite implementations use a `join_requests` table with the following schema:

```sql
CREATE TABLE IF NOT EXISTS join_requests (
  group_id TEXT NOT NULL,
  requester_stable_pubkey TEXT NOT NULL,
  key_package_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
```

Index requirements:

- An index on `(group_id, id)` supports efficient pending-request queries.
- Indexes on `read_at` and `created_at` support efficient expiration queries.

Deletion behavior:

- `deleteExpiredJoinRequests` uses a single `DELETE` statement with an `OR` condition for both thresholds.
- This ensures atomic cleanup in a single transaction.

Additional SQLite implementation details for `fetchManyPendingJoinRequests`:

- A single transaction atomically marks all unread requests as read across all requested groups, then fetches all records using a CTE-based query ordered by input group order.
- The CTE uses a `VALUES` clause parameterized by group count to avoid dynamic SQL injection while handling dynamic group counts.

### 6. Contracts

Join requests use the following contract method names and schemas.

```typescript
export const COORDINATOR_METHODS = {
  // ... existing methods
  storeJoinRequest: "join_request_store",
  fetchPendingJoinRequests: "join_request_take",
  fetchManyPendingJoinRequests: "join_request_take_many",
} as const;
```

Method naming follows the existing `welcome_store` / `welcome_take` / `msg_fetch_many` conventions.

Input and output schemas:

```typescript
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

export const fetchManyPendingJoinRequestsInputSchema = z.object({
  groups: z.array(z.object({ gid: z.string().min(1) })).min(1),
});

export const joinRequestWithGroupSchema = joinRequestSchema.extend({
  gid: z.string(),
});

export const fetchManyPendingJoinRequestsOutputSchema = z.object({
  requests: z.array(joinRequestWithGroupSchema),
});
```

### 7. Server Authorization

Server-side authorization enforces group existence and KeyPackage ownership.

#### 7.1 `storeJoinRequest`

Authorization requirements:

- The caller identity MUST be authenticated via transport context.
- The KeyPackage MUST exist: `getKeyPackage(kp_ref) !== null`.
- The caller MUST own the KeyPackage: `getKeyPackage(kp_ref)?.stablePubkey === callerIdentity`.

If any check fails, the server MUST reject the request with an appropriate error.

Rate limiting:

- The method MUST be rate-limited using the existing token bucket mechanism.

#### 7.2 `fetchPendingJoinRequests`

Authorization requirements:

- No identity check is required (mirrors [`fetchGroupMessages`](../src/server/coordinatorMethods.ts:609)).
- The method MUST be rate-limited only.

This allows any client to discover pending requests for a group, enabling flexible member-side review workflows.

#### 7.2b `fetchManyPendingJoinRequests`

Authorization requirements:

- No identity check is required (mirrors [`fetchManyGroupMessages`](../src/server/coordinatorMethods.ts:622)).
- The method MUST be rate-limited only.

This allows any client to discover pending requests across multiple groups in a single call, reducing network round-trips for users who are members of many groups.

### 8. Validation Rules

#### 8.1 At `storeJoinRequest` Time

| Case | Behavior | Rationale |
|---|---|---|
| `kp_ref` not found | Reject with `"Unknown key package ref"` | The KeyPackage was consumed or removed |
| `kp_ref` exists but owner mismatch | Reject with `"Unauthorized key package ref"` | Prevents impersonation |
| Duplicate unread request | Return existing record | Idempotent store semantics |
| `kp_ref` is last-resort | Allow | Last-resort KPs remain available |
| Per-group cap reached | Reject with `"Too many pending join requests for this group"` | Prevents unbounded accumulation per group |

Group existence is not validated. The coordinator does not require a group to have message history before accepting join requests. This is bounded by the per-group pending request cap (default: 100) and existing rate limiting.

#### 8.2 At Member Processing Time (Client-Side)

These cases are not coordinator errors. They describe client-side handling when a member acts on a fetched request.

| Case | Client Behavior |
|---|---|
| `consumeKeyPackage({ id: kp_ref })` returns `null` | KeyPackage was consumed by another operation. Member skips this request. |
| Two members both fetch and try to consume the same KeyPackage | Only one `consumeKeyPackage` succeeds; the other gets `null` and skips. Natural race resolution. |
| Member creates Add+Commit but `postGroupMessage` fails | Member retries posting. The join request is already marked `readAt`, so it won't reappear. Member tracks this as a pending epoch operation. |
| Requester was already added by another member | The Add+Commit fails MLS validation on other members' devices (duplicate leaf). MLS-level conflict, not a coordinator concern. |

### 9. Edge Cases

#### 9.1 KeyPackage Consumed by Unrelated Group

The requester's KeyPackage could be consumed by someone adding them to a different group. The join request then references a stale `kp_ref`. When a member tries to consume it, they get `null` and skip. The requester must publish a new KeyPackage and submit a new request.

This is acceptable because KeyPackages are inherently one-time-use resources.

#### 9.2 Request TTL Expires Before Processing

The cleanup timer deletes the request (same as Welcomes). The requester submits a new request. No coordinator complexity.

#### 9.3 Requester Wants to Update KeyPackage on Pending Request

The requester publishes a new KeyPackage and calls `storeJoinRequest` again with the new `kp_ref`.

- If the old request is already read (has `readAt` set), the dedup check only applies to unread requests. The new request replaces the old one naturally.
- If the old request is still unread, the dedup returns the existing record. The requester must wait for it to be read or expire.

#### 9.4 Group Doesn't Exist

The coordinator intentionally does NOT validate group existence at `storeJoinRequest` time. This allows freshly created groups with no messages to accept join requests immediately. Storage is bounded by the per-group pending request cap and TTL-based cleanup.

#### 9.5 Request Spam

A malicious user could flood a group with join requests. Mitigations:

- Existing rate limiting limits call frequency.
- Deduplication prevents the same user from creating multiple unread requests.
- Per-identity quota (similar to KeyPackage quota) could limit total pending requests per requester.

### 10. Processing Flow

The join request flow proceeds as follows:

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

### 11. Cleanup Timer Extension

The existing cleanup timer in [`Coordinator`](../src/coordinator/coordinator.ts:209) extends to also call `deleteExpiredJoinRequests()` with the same thresholds and interval.

No new timer is needed. Both Welcomes and join requests share the same cleanup cadence.

### 12. Interoperability Requirements

Implementations MUST agree on all of the following:

- Join request record structure and field semantics
- Store-time validation rules for group existence and KeyPackage ownership
- Read-tracking behavior on fetch
- Dual-threshold expiration semantics
- Contract method names and schema shapes

Implementations MUST reject malformed requests and unauthorized KeyPackage references.

### 13. Rationale

This design keeps the coordinator minimal and uniform while enabling the shareable link use case.

- The coordinator stays stateless about group membership, consistent with [`spec/00.md`](../spec/00.md).
- Group existence is intentionally not validated for join requests, allowing freshly created groups to accept join requests before any messages are posted (the bootstrap scenario).
- KeyPackage consumption races resolve naturally: one consumer wins, others get `null`.
- TTL cleanup handles all orphaned state: no manual cancellation needed.
- Per-group pending request caps (default: 100) prevent unbounded accumulation from fake group IDs while remaining generous enough for real groups.
- Client-side failures are recoverable: members can retry, requesters can re-request.

The join request mechanism is intentionally symmetric with Welcomes. This symmetry reduces cognitive load for implementers and ensures consistent coordinator behavior across both invitation directions.

The design is resilient because it treats the coordinator as a signaling service, not a group manager. Clients retain full responsibility for MLS state transitions and membership decisions.
