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
| **Lifecycle** | lives until `consumed` ack or `maxAge` ceiling; observation never deletes | lives until `consumed` ack or `maxAge` ceiling; observation never deletes |

This symmetry ensures consistent coordinator behavior and simplifies implementation. A join request is the **admin's** inbox item, retired when the admin handles it; a Welcome is the **invitee's** inbox item, retired when the invitee consumes it. Each owner retires their own record via an optional `consumed` ack on the corresponding fetch call. The coordinator never pairs the two, which keeps it stateless about the approval-to-invitation link.

### 3. Types

Join requests use the following record and input types.

```typescript
export interface JoinRequestRecord {
  groupId: string;
  requesterStablePubkey: string;
  keyPackageRef: string;
  createdAt: number;
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
fetchPendingJoinRequests(
  groupId: string,
  consumed?: ConsumedJoinRequestRef[],
): JoinRequestRecord[];
fetchManyPendingJoinRequests(input: FetchManyPendingJoinRequestsInput): JoinRequestRecord[];
deleteExpiredJoinRequests(maxAgeThreshold: number): number;
```

```typescript
export interface ConsumedJoinRequestRef {
  requesterStablePubkey: string;
  createdAt: number;
}
```

#### 4.1 `storeJoinRequest`

Creates a join request record.

Validation requirements:

- The KeyPackage MUST exist in coordinator storage (verified via `getKeyPackage(keyPackageRef) !== null`).
- The caller MUST own the KeyPackage (verified via `getKeyPackage(keyPackageRef)?.stablePubkey === callerIdentity`).

Group existence is intentionally NOT validated. The coordinator is a signaling service and does not require a group to have message history before accepting join requests. This allows freshly created groups with no messages to accept join requests immediately (the "bootstrap" scenario). Per-group caps on pending join requests and existing rate limiting bound storage abuse from non-existent group IDs.

Deduplication behavior:

- If a pending request already exists for the same `(groupId, requesterStablePubkey)`, the coordinator MUST return the existing record without error.
- This provides idempotent store semantics. A requester can hold exactly one pending request per group at a time; the slot is freed only when the existing request is consumed (acked on a later fetch) or crosses the `maxAge` ceiling. Observation alone does not free it.

Last-resort KeyPackages:

- Coordinators MUST accept last-resort KeyPackages for join requests.
- Last-resort KeyPackages are not consumed on retrieval, so they remain available for multiple join attempts.

#### 4.2 `fetchPendingJoinRequests`

Returns all join requests for the specified group.

Observation never deletes. Records are retired only by an explicit `consumed` ack or by the `maxAge` ceiling (see `deleteExpiredJoinRequests`).

Consumed ack (optional):

- When the caller passes `consumed`, the coordinator MUST delete each referenced record (scoped to `groupId`, keyed by `requesterStablePubkey` + `createdAt`) atomically before the fetch, so retired records are never echoed back.
- The ack is idempotent: a `consumed` ref that matches no record is a no-op.
- Keys for `consumed` are values the coordinator itself returned in a prior fetch, so the caller echoes its own inbox state back. No new identifier field is introduced.

The method returns requests in storage order. Clients are responsible for filtering, sorting, or paginating as needed.

#### 4.2b `fetchManyPendingJoinRequests`

Returns all join requests for multiple groups in a single call.

Input schema:

```typescript
{
  groups: { groupId: string }[];
  consumed?: { groupId: string; requesterStablePubkey: string; createdAt: number }[];
}
```

Consumed semantics:

- When `consumed` is provided, each item carries its own `groupId` (since consumed items may span the requested groups); the coordinator retires them with the same atomic delete-before-fetch semantics as the single-group call.
- This mirrors the behavior of [`fetchPendingJoinRequests()`](#42-fetchpendingjoinrequests) but applied across all requested groups in a single transaction.

The method returns requests ordered by input group order, then storage order within each group. Each returned record carries its `groupId` so clients can distinguish which group a request belongs to.

Results from groups with no pending requests are simply omitted from the output; the method never errors for non-existent or empty groups.

#### 4.3 `deleteExpiredJoinRequests`

Deletes join requests older than the max-age ceiling.

Expiration rule:

- Records whose `createdAt < maxAgeThreshold` are deleted, regardless of read state.
- When `maxAgeThreshold <= 0`, no records are deleted (retention disabled).

A single clock governs cleanup. Observation (fetch) never deletes a record; only an explicit `consumed` ack or crossing this `maxAge` ceiling removes one. This replaces the previous dual-threshold model, which deleted records on a short timer triggered by observation and could orphan slow-acting admins or invitees mid-flow.

The method returns the count of deleted records.

### 5. Storage Interface

Storage backends MUST implement the following methods.

```typescript
storeJoinRequest(record: JoinRequestRecord): JoinRequestRecord;
fetchPendingJoinRequests(
  groupId: string,
  consumed?: ConsumedJoinRequestRef[],
): JoinRequestRecord[];
fetchManyPendingJoinRequests(
  input: FetchManyPendingJoinRequestsInput,
): JoinRequestRecord[];
deleteExpiredJoinRequests(maxAgeThreshold: number): number;
```

Both in-memory and SQLite storage backends MUST provide parity coverage for these methods.

#### 5.1 In-Memory Storage

In-memory implementations store join requests in a group-keyed map.

- `storeJoinRequest` appends to the group's request list after deduplication.
- `fetchPendingJoinRequests` retires `consumed` refs first (filtering the list), then returns the remainder.
- `fetchManyPendingJoinRequests` partitions `consumed` by `groupId`, delegates to `fetchPendingJoinRequests` per group, and flattens results. Ordering follows input group order.
- `deleteExpiredJoinRequests` filters the global request set by `createdAt >= maxAgeThreshold` in a single pass.

#### 5.2 SQLite Storage

SQLite implementations use a `join_requests` table with the following schema:

```sql
CREATE TABLE IF NOT EXISTS join_requests (
  group_id TEXT NOT NULL,
  requester_stable_pubkey TEXT NOT NULL,
  key_package_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Index requirements:

- An index on `(group_id, id)` supports efficient pending-request queries.

Deletion behavior:

- `deleteExpiredJoinRequests` uses a single `DELETE ... WHERE created_at < ?` statement.
- Consumed retirement uses a parameterized `DELETE ... WHERE group_id = ? AND requester_stable_pubkey = ? AND created_at = ?`, run inside the fetch transaction before the select.

Additional SQLite implementation details for `fetchManyPendingJoinRequests`:

- A single transaction retires consumed refs per group, then fetches all records using a CTE-based query ordered by input group order.
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
  consumed: z.array(z.object({
    pk: z.string().min(1),
    at: z.number().int(),
  })).optional(),
});

export const fetchPendingJoinRequestsOutputSchema = z.object({
  requests: z.array(joinRequestSchema),
});

export const fetchManyPendingJoinRequestsInputSchema = z.object({
  groups: z.array(z.object({ gid: z.string().min(1) })).min(1),
  consumed: z.array(z.object({
    gid: z.string().min(1),
    pk: z.string().min(1),
    at: z.number().int(),
  })).optional(),
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
| Duplicate pending request | Return existing record | Idempotent store semantics |
| `kp_ref` is last-resort | Allow | Last-resort KPs remain available |
| Per-group cap reached | Reject with `"Too many pending join requests for this group"` | Prevents unbounded accumulation per group |

Group existence is not validated. The coordinator does not require a group to have message history before accepting join requests. This is bounded by the per-group pending request cap (default: 100) and existing rate limiting.

#### 8.2 At Member Processing Time (Client-Side)

These cases are not coordinator errors. They describe client-side handling when a member acts on a fetched request.

| Case | Client Behavior |
|---|---|
| `consumeKeyPackage({ id: kp_ref })` returns `null` | KeyPackage was consumed by another operation. Member skips this request. |
| Two members both fetch and try to consume the same KeyPackage | Only one `consumeKeyPackage` succeeds; the other gets `null` and skips. Natural race resolution. |
| Member creates Add+Commit but `postGroupMessage` fails | Member retries posting. The join request remains in the coordinator's inbox until the admin acks it via `consumed` on a later fetch; the coordinator is non-destructive on observation. Member tracks this as a pending epoch operation. |
| Requester was already added by another member | The Add+Commit fails MLS validation on other members' devices (duplicate leaf). MLS-level conflict, not a coordinator concern. |

### 9. Edge Cases

#### 9.1 KeyPackage Consumed by Unrelated Group

The requester's KeyPackage could be consumed by someone adding them to a different group. The join request then references a stale `kp_ref`. When a member tries to consume it, they get `null` and skip. The requester must publish a new KeyPackage and submit a new request.

This is acceptable because KeyPackages are inherently one-time-use resources.

#### 9.2 Request Outlives an Admin's Attention Span

A slow admin may poll pending requests, see a notification, and not act on it for hours or days. Observation (`fetchPendingJoinRequests`) never deletes. The request survives until the admin explicitly acks it via `consumed` (on a later fetch) or until the `maxAge` ceiling (default 30 days) is crossed. This replaces a previous short read-TTL that could orphan requests mid-review. The requester never needs to re-submit because of cleanup timing.

#### 9.3 Requester Wants to Update KeyPackage on Pending Request

The requester publishes a new KeyPackage and calls `storeJoinRequest` again with the new `kp_ref`.

- While the previous request is still pending, the dedup check returns the existing record. The requester cannot replace it by re-storing.
- The requester must wait for the admin to handle (consume) the old request, or for it to cross the `maxAge` ceiling, before a new request with the updated `kp_ref` can be stored.

#### 9.4 Group Doesn't Exist

The coordinator intentionally does NOT validate group existence at `storeJoinRequest` time. This allows freshly created groups with no messages to accept join requests immediately. Storage is bounded by the per-group pending request cap and the `maxAge` cleanup ceiling.

#### 9.5 Request Spam

A malicious user could flood a group with join requests. Mitigations:

- Existing rate limiting limits call frequency.
- Deduplication prevents the same user from holding more than one pending request per group at a time.
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

The admin retires the join request by passing it in `consumed` on a subsequent `fetchPendingJoinRequests` call, once the request has been handled (approved or rejected). If the admin never acks, the request falls to the `maxAge` ceiling (default 30 days). This mirrors Welcomes, which the invitee retires via `consumed` on `fetchPendingWelcomes` once they join locally.

### 11. Cleanup Timer Extension

The existing cleanup timer in [`Coordinator`](../src/coordinator/coordinator.ts:209) extends to also call `deleteExpiredJoinRequests()` with the same `maxAgeThreshold` and interval used for Welcomes.

No new timer is needed. Both Welcomes and join requests share the same cleanup cadence and the same single max-age clock. Observation and per-call `consumed` acks are independent of the timer.

### 12. Interoperability Requirements

Implementations MUST agree on all of the following:

- Join request record structure and field semantics
- Store-time validation rules for group existence and KeyPackage ownership
- Single max-age expiration semantics: a record lives until `consumed` or until `createdAt < maxAgeThreshold`
- The `consumed` ack contract: optional, idempotent, keyed by fields the coordinator already returns

Implementations MUST reject malformed requests and unauthorized KeyPackage references.

### 13. Rationale

This design keeps the coordinator minimal and uniform while enabling the shareable link use case.

- The coordinator stays stateless about group membership, consistent with [`spec/00.md`](../spec/00.md).
- Group existence is intentionally not validated for join requests, allowing freshly created groups to accept join requests before any messages are posted (the bootstrap scenario).
- KeyPackage consumption races resolve naturally: one consumer wins, others get `null`.
- Retention is bounded without manual cancellation: a single `maxAge` ceiling (default 30 days) reaps abandoned records, and explicit `consumed` acks retire records promptly once an admin has handled them. Observation never deletes, so slow reviewers never orphan a request mid-flow.
- Per-group pending request caps (default: 100) prevent unbounded accumulation from fake group IDs while remaining generous enough for real groups.
- Client-side failures are recoverable: members can retry, requesters can re-request.

The join request mechanism is intentionally symmetric with Welcomes. This symmetry reduces cognitive load for implementers and ensures consistent coordinator behavior across both invitation directions.

The design is resilient because it treats the coordinator as a signaling service, not a group manager. Clients retain full responsibility for MLS state transitions and membership decisions.
