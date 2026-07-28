# cordn-sdk Design

- Status: Draft
- Depends on: [`spec/00.md`](../spec/00.md) (coordinator & identity model), [`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts)
- References studied: `reference/marmot-ts`, `reference/ts-mls`, `reference/openmls`, `reference/mdk`, `reference/cordn-web`

## Goal

A high-level, modular TypeScript SDK for building cordn apps — `@cordn/sdk` — that delivers **marmot-grade developer experience without marmot-grade complexity**, because cordn's coordinator is the sequencer (per-group monotonic cursors, spec §4). The SDK absorbs every MLS-over-coordinator gotcha the CLI and cordn-web each had to learn independently, behind an expressive, storage- and transport-agnostic surface.

The problem statement is `reference/cordn-web/src/lib/services/`: ~60 `chat*.svelte.ts` files that re-implement the CLI's MLS coordination logic in Svelte flavor. That duplication is the cost this SDK pays off; cordn-web is its first migration target.

## Thesis

cordn's delivery service orders messages within a group (spec §2, §4). Therefore the SDK **does not need** marmot's heaviest machinery — fork recovery, convergence policies, history trees, ingestion pools. It **does** need: epoch-aware publish-before-apply, structured ingest dispositions, defer/retry for out-of-epoch messages, and the cordn-specific invariants below. The pitch: *marmot-grade DevX without marmot-grade complexity, because cordn's DS does the ordering.*

## Decision log

All items below are resolved.

| # | Decision | Resolution |
|---|---|---|
| 1 | MLS foundation | Wrap `ts-mls`; **consume it, do not encapsulate it**. Real `ts-mls` types appear in the public surface (`ClientState`, `Proposal`, `Welcome`, `KeyPackage`…). Re-exported via `@cordn/sdk/mls`. |
| 2 | Identity & signing | Adopt the **NIP-07 Nostr signer interface** as the identity shape. Verified sufficient: cordn's publication-payload signature (spec §7) is a standard Nostr event signature (`verifyEvent` + credential/pubkey match), **not** raw schnorr — so, unlike marmot, no separate raw signer is needed. |
| 3 | Ephemeral channel key | The ephemeral transport channel is signed by an **SDK-generated ephemeral keypair**, deliberately *not* the NIP-07 identity, to preserve unlinkability. The SDK owns ephemeral-key lifecycle; the app supplies one NIP-07 signer for the authed channel only. |
| 4 | Dual transport | The authed/ephemeral split is a **privacy invariant, not a config knob**. The SDK owns the method→channel routing table; the transport exposes two channels; the app never chooses per-call (routing `PostGroupMessage` over authed would deanonymize the sender). |
| 5 | Storage | One opaque-blob `KeyValueStore<T>` interface (marmot shape), in-memory default, app-supplied backends (IndexedDB / SQLite / OPFS). **Schema versioned from v1** (one integer on the blob — cheap migration insurance, openmls lesson). Granular typed storage is YAGNI. |
| 6 | Concurrency | The engine owns **per-group operation serialization** (one in-flight commit, queue the rest). Today cordn-web hand-rolls this as `coordinatorOperationChains` (`reference/cordn-web/src/lib/services/chatRuntime.ts:236`); it must not be app-side. |
| 7 | Welcome / join-request inboxes | Expose **correct, typed fetch primitives** (consumed-ref ack handled internally; welcome-preview-before-join; join-request first-class). **No polling/loop imposition** — the app decides cadence. |
| 8 | Group-message sync | The fetch-first-then-subscribe loop (per-group cursors, backlog-then-live unified ingest) **is** SDK-owned via an opt-in `group.runInbox()` runner, because mismanaging cursors loses or double-processes messages. Raw primitives (`group.fetch(afterCursor)`, `group.subscribe(afterCursor)`) remain available for apps that want full control. |
| 9 | Package layout | **One package** `@cordn/sdk` with subpath `exports` (`.`, `/engine`, `/extra`, `/testing`, `/mls`). Split a separate `@cordn/sdk-mcp` out **only when** a real consumer can't stomach the `@contextvm/sdk` dependency weight. |
| 10 | In-process coordinator transport | **Test-only.** Ships under `@cordn/sdk/testing`; `@cordn/coordinator` is a `devDependency`. The "clients never embed the coordinator" boundary (AGENTS.md) holds. The SDK dogfoods this transport for its own suite — full end-to-end tests with zero Nostr. |
| 11 | Core relocation | Move the **metadata-extension codec** (`packages/cli/src/groupMetadata.ts`) into `@cordn/core` — it is pure protocol. `messageEnvelope.ts` **stays app-side**: it depends on `nostr-tools` and wraps chat messages as Nostr kind-9 unsigned events (app convention), which would violate `@cordn/core`'s dep-light, nostr-tools-free contract. |
| 12 | Engine transport coupling | The engine is **transport-agnostic** (consumes an inbound record feed, emits outbound publish effects). Only the `CoordinatorRuntime` is cordn/coordinator-aware. |
| 13 | Events / iteration | `engine.ingest()` is an `AsyncGenerator<IngestResult>` (backpressure-friendly); `CordnGroup` adds a thin typed `EventEmitter` for app ergonomics. mdk's drain model is a Rust-ism — not used. |
| 14 | Constructable deps | One injected `deps` context (`{ storage, crypto, clock, timers, rng }`) threaded through construction. No ambient singletons (openmls `OpenMlsProvider` lesson). |
| 15 | Status taxonomy | `active | removed | poisoned` are **recoverable group statuses, not thrown crashes**. `poisoned` has a recovery verb (`group.recover()` / `group.destroy()`), not just a label. |
| 16 | Error taxonomy | The thrown side is a **named hierarchy** (`NotAMemberError`, `StaleEpochError`, `UnreadableMessageError`, `CoordinatorUnavailableError`, `WelcomeForUnknownKeyPackageError` …). Apps catch by type, never by parsing message strings. |
| 17 | Deferred (YAGNI) | Full convergence/fork-recovery + fork trees; multi-device sync; granular typed storage; framework-specific store bindings (svelte/rx); audit/forensics sink. Multi-device is not precluded: `KeyPackageManager` supports per-device slots from day one. |

## Architecture

```
┌──────────────────────────────────────────────┐
│  Application (cordn-web, CLI, …)             │
└──────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────┐
│  Client layer   CordnClient + managers       │
│                 (groups, keyPackages,        │
│                  invites, joinRequests,      │
│                  coordinators)               │
└──────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────┐
│  Engine layer   CordnGroupEngine             │
│                 (ClientState, lifecycle,     │
│                  dispositions, serialize,    │
│                  two-phase commit)           │
│                 transport-agnostic           │
└──────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────┐
│  Core layer     @cordn/core (existing)       │
│                 contracts, codecs, metadata  │
│                 ext, last-resort KP, env     │
└──────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────┐
│  Foundation     ts-mls (RFC 9420)            │
└──────────────────────────────────────────────┘
```

`CordnGroup` is a thin facade: it owns a `GroupSession` (wrapping the engine) and a `CoordinatorRuntime` (driving transport effects). This mirrors marmot-ts's `MarmotGroup`/`GroupSession`/`GroupRuntime` split, minus the convergence machinery.

### Dependency graph (workspace packages)

```
@cordn/sdk  ──depends on──▶ @cordn/core ──depends on──▶ ts-mls, zod
    │
    └── (devDep, test-only) ──▶ @cordn/coordinator   ← via @cordn/sdk/testing

@cordn/sdk/testing ──devDep──▶ @cordn/coordinator     (in-process transport)
production transport impl   ──depends on──▶ @contextvm/sdk   (lives in /extra or later @cordn/sdk-mcp)
```

The app-facing dependency graph never includes `@cordn/coordinator`.

## Packages & exports

Single new workspace package at `packages/sdk`, declared in `pnpm-workspace.yaml`, with a `paths` entry in `tsconfig.json` (per AGENTS.md "when adding a package").

```jsonc
// packages/sdk/package.json — "exports"
{
  ".":           { "types": "./src/index.ts", "default": "./src/index.ts" },         // CordnClient + managers
  "./engine":    { "types": "./src/engine/index.ts", "default": "./src/engine/index.ts" },
  "./extra":     { "types": "./src/extra/index.ts", "default": "./src/extra/index.ts" }, // InMemoryKeyValueStore, adapters
  "./testing":   { "types": "./src/testing/index.ts", "default": "./src/testing/index.ts" }, // in-process coordinator transport
  "./mls":       { "types": "./src/mls.ts", "default": "./src/mls.ts" }               // re-exports ts-mls
}
```

## Key abstractions

### Identity & keys — three layers

The doc makes this explicit because it is a classic confusion source (and the authed/ephemeral split depends on it).

| Layer | What it is | Source | Used for |
|---|---|---|---|
| **1. Identity key** | your stable Nostr pubkey | NIP-07 signer (`getPublicKey`) | BasicCredential identity (spec §6), authed-channel transport signing, publication-payload signature (spec §7) |
| **2. Ephemeral transport key** | fresh keypair, **not** your identity | SDK-generated, rotatable | ephemeral-channel transport signing — preserves unlinkability |
| **3. MLS leaf keys** | per-KeyPackage initiation/encryption keys | `ts-mls`-generated | inside `PrivateKeyPackage`s, stored in `keyPackageStore` |

```ts
// @cordn/sdk — identity shape (NIP-07 interface, not the window binding)
export interface CordnSigner {
  getPublicKey(): Promise<string>;        // stable hex pubkey → BasicCredential identity
  signEvent(event: UnsignedNostrEvent): Promise<NostrEvent>; // authed-channel transport + publication payload
}

// Node/native apps implement CordnSigner over a private key; browser apps over window.nostr.
// The SDK never calls window.nostr directly.
```

### Transport — dual channel, SDK-owned routing

```ts
// @cordn/sdk/engine — transport seam
export interface CordnTransport {
  /** Authed channel — signed by the caller's NIP-07 identity. */
  authed: CordnTransportChannel;
  /** Ephemeral channel — signed by an SDK-managed ephemeral key. */
  ephemeral: CordnTransportChannel & {
    subscribeManyGroupMessages(
      input: SubscribeManyGroupMessagesInput,
    ): Promise<GroupMessageStream>;
  };
}

export interface CordnTransportChannel {
  call<T>(method: CoordinatorMethodName, input: unknown): Promise<T>;
}
```

The **routing table is owned by the SDK** and is not configurable — it encodes the privacy invariant verified in `packages/cli/src/coordinatorClient.ts`:

```ts
// SDK-internal, immutable
const CHANNEL: Record<CoordinatorMethodName, "authed" | "ephemeral"> = {
  publishKeyPackage:              "authed",   // your KP — identity-bound
  removeKeyPackages:              "authed",   // your KP — identity-bound
  fetchPendingWelcomes:           "authed",   // your welcomes — identity-bound
  storeJoinRequest:               "authed",   // your join ask — identity-bound
  consumeKeyPackage:              "ephemeral",
  listAvailableKeyPackages:       "ephemeral",
  storeWelcome:                   "ephemeral", // deliver to invitee — unlinkable
  fetchManyPendingJoinRequests:   "ephemeral",
  postGroupMessage:               "ephemeral", // group traffic — unlinkable
  fetchManyGroupMessages:         "ephemeral",
  subscribeManyGroupMessages:     "ephemeral",
};
```

Implementations: a production `ContextVmTransport` (in `@cordn/sdk/extra`, depends on `@contextvm/sdk` — split to `@cordn/sdk-mcp` if/when the dep weight bites) and an `InProcessTransport` in `@cordn/sdk/testing`.

### Storage — opaque blob, versioned

```ts
// @cordn/sdk — storage interface (marmot GenericKeyValueStore shape)
export interface KeyValueStore<T> {
  getItem(key: string): Promise<T | null>;
  setItem(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}

// Persisted per group — versioned from day one (openmls CURRENT_VERSION lesson)
export interface SerializedGroupBlob {
  version: 1;                          // bump + migrate on schema change
  state: Uint8Array;                   // ts-mls ClientState bytes
  metadata?: CordnGroupMetadata;       // decoded group metadata ext cache
  fetchCursor: number;                 // last applied per-group cursor
  lastCursor: number;
  status: "active" | "removed" | "poisoned";
  pending?: PendingEpochOperation[];   // publish-before-apply, survives restart
}
```

`@cordn/sdk/extra` ships `InMemoryKeyValueStore`. App supplies IndexedDB / SQLite / OPFS backends. An encrypted decorator (key-wrap any backend) is a later `extra`.

### Engine — lifecycle, dispositions, serialization, two-phase commit

The engine owns `ClientState` and the four cordn-specific invariants that today live as fragile CLI/cordn-web code: publish-before-apply, self-echo reconciliation, operation serialization, and structured (non-string-matched) ingest classification.

```ts
// @cordn/sdk/engine
export type GroupLifecycle = "stable" | "pendingPublish" | "merging";

export type SendIntent =
  | { kind: "application"; plaintext: Uint8Array }
  | { kind: "proposal"; proposal: Proposal }
  | { kind: "commit"; actions: ProposalAction[] }   // batched proposals + commit
  | { kind: "selfUpdate" };

export interface IngestResult {
  ref: MessageRef;
  disposition:
    | "processed"            // advanced state or delivered an app message
    | "deferred"             // out-of-epoch / undecryptable now; retry as history grows
    | "selfEcho"             // matched a pending commit before MLS reprocessing
    | "autoCommit"           // engine staged a self_remove-only commit (peer departure)
    | "removed"              // an inbound commit removed this member
    | "unreadable"           // permanently undecryptable
    | "rejectedByPolicy";    // admin-authorization callback rejected
  applicationMessage?: Uint8Array;   // present when disposition === "processed" and it's app data
  error?: CordnError;               // present on unhealthy dispositions
}

export class CordnGroupEngine {
  constructor(opts: {
    ciphersuite: CiphersuiteImpl;
    crypto: CryptoProvider;
    clock?: () => number;            // injectable; default Date.now
    timers?: TimerSink;              // injectable; default setTimeout/clearTimeout
    adminPolicy?: AdminCommitPolicy; // authorization callback
  });

  get state(): ClientState;
  get lifecycle(): GroupLifecycle;
  get status(): "active" | "removed" | "poisoned";

  /** Serialized one in-flight commit at a time; queues concurrent sends. */
  send(intent: SendIntent): Promise<OutboundEffect[]>;
  /** Single ingestion path for fetch backlog and live stream. Backpressure-friendly. */
  ingest(records: AsyncIterable<GroupMessage>): AsyncGenerator<IngestResult>;
  /** openmls two-phase: call after the coordinator accepts the published commit. */
  confirmPublished(ref: MessageRef): void;
  /** Roll back a staged commit whose publish failed. */
  rollbackPending(ref: MessageRef): void;
}
```

The `OutboundEffect` (e.g. `{ method: "postGroupMessage"; input }`) is what `CoordinatorRuntime` publishes. The engine never sees the transport.

`IngestResult.disposition` **replaces** today's string-matching classifiers in `packages/cli/src/groupSync.ts` (`isFormerEpochIssue`, `isStaleGenerationIssue`, `isRemovedMemberCommitIssue`). Each maps to a typed branch instead of a regex over an error message.

### Client facade & managers

```ts
// @cordn/sdk
export class CordnClient {
  constructor(opts: {
    signer: CordnSigner;               // NIP-07 — authed channel only
    transport: CordnTransport;         // provides authed + ephemeral
    storage: KeyValueStore<SerializedGroupBlob>;
    keyPackageStorage: KeyValueStore<StoredKeyPackage>;
    crypto?: CryptoProvider;           // default noble
    clock?: () => number;
  });

  readonly keyPackages: KeyPackageManager;     // publish/list/consume/remove; last-resort semantics; per-device slots
  readonly groups: GroupsManager;              // create / joinFromWelcome / previewWelcome / load / destroy
  readonly invites: InviteManager;            // fetch primitives (no loop) — decision #7
  readonly joinRequests: JoinRequestManager;  // fetch + store primitives — first-class, decision (8th gotcha)
  readonly coordinators: CoordinatorManager;  // health, reconnect, write-target selection

  group(id: string | Uint8Array): CordnGroup;
}

export interface CordnGroup {
  readonly id: Uint8Array;
  readonly state: ClientState;
  readonly info: CordnGroupInfo;        // name, description, members, relays
  readonly status: "active" | "removed" | "poisoned";
  readonly lifecycle: GroupLifecycle;

  send(plaintext: Uint8Array): Promise<MessageRef>;
  propose<T>(action: ProposalAction<T>): Promise<MessageRef>;
  commit(actions?: ProposalAction[]): Promise<MessageRef>;   // batched commit
  updateMetadata(md: Partial<CordnGroupMetadata>): Promise<MessageRef>;

  fetch(afterCursor?: number): Promise<GroupMessage[]>;              // primitive
  subscribe(afterCursor?: number): Promise<GroupMessageStream>;      // primitive
  runInbox(opts?: { signal?: AbortSignal }): InboxHandle;            // opt-in runner (decision #8)

  recover(): Promise<void>;   // re-fetch from 0 + rejoin, for poisoned groups
  destroy(): Promise<void>;

  on<E extends keyof CordnGroupEvents>(e: E, fn: (p: CordnGroupEvents[E]) => void): () => void;
  // events: stateChanged, message, epoch, memberAdded, memberRemoved, selfRemoved, syncIssue, statusChanged
}
```

### Proposals & actions (type-safe, composable)

Borrowed directly from marmot-ts's `ProposalAction` model — decouples proposal construction from the group, making commits composable.

```ts
// @cordn/sdk
export type ProposalContext = { ciphersuite: CiphersuiteImpl; state: ClientState };
export type ProposalAction<T extends Proposal = Proposal> =
  (ctx: ProposalContext) => Promise<T> | T;

// Builders live in @cordn/sdk and encode cordn gotchas (e.g. verify publication payload,
// capabilities-vs-values distinction, metadata-ext advertisement)
export function proposeAddMember(kpEvent: PublishedKeyPackage): ProposalAction<ProposalAdd>;
export function proposeRemoveMember(stablePubkey: string): ProposalAction<ProposalRemove>;
export function proposeUpdateMetadata(md: Partial<CordnGroupMetadata>): ProposalAction;

// Usage: one commit, multiple actions
await group.commit([proposeAddMember(bobKp), proposeAddMember(carolKp)]);
```

### Errors

```ts
// @cordn/sdk — named hierarchy (the thrown counterpart to ingest dispositions)
export abstract class CordnError extends Error { abstract readonly code: string; }
export class NotAMemberError            extends CordnError { code = "NOT_A_MEMBER"; }
export class StaleEpochError            extends CordnError { code = "STALE_EPOCH"; }
export class UnreadableMessageError     extends CordnError { code = "UNREADABLE"; }
export class CoordinatorUnavailableError extends CordnError { code = "COORDINATOR_UNAVAILABLE"; }
export class WelcomeForUnknownKeyPackageError extends CordnError { code = "WELCOME_NO_KP"; }
export class PublicationPayloadInvalidError    extends CordnError { code = "PUBLICATION_INVALID"; }
```

## Gotchas the SDK owns (so app devs never learn them)

Mapped to where each is handled:

| # | Gotcha | Owner |
|---|---|---|
| 1 | Fetch-first-then-subscribe; backlog replay before live; independent per-group cursors (spec §4–5; AGENTS.md) | `CoordinatorRuntime` + opt-in `group.runInbox()` |
| 2 | Self-echo reconciliation without MLS reprocessing | `engine.ingest` disposition `"selfEcho"` |
| 3 | Publish-before-apply: finalize add/remove/metadata only after inbound confirmation | `GroupLifecycle` + `confirmPublished`/`rollbackPending` |
| 4 | Replace string-matched ts-mls errors with structured dispositions | `IngestResult.disposition` |
| 5 | Per-group operation serialization (no concurrent commits) | `engine.send` internal queue |
| 6 | Verify coordinator-served KeyPackage publication payloads before use (spec §7–8) | `KeyPackageManager` + `proposeAddMember` — apps cannot skip it |
| 7 | Last-resort key-package reuse + consume semantics | `KeyPackageManager` |
| 8 | Metadata-ext capabilities advertise *support*, group state carries the *values* | `proposeAddMember` / `CordnGroupInfo` |
| 9 | Welcome preview before join; join-request flow first-class | `groups.previewWelcome`, `joinRequests` manager |
| 10 | `active / removed / poisoned` as recoverable status, not crashes | `CordnGroup.status` + `recover()` |
| 11 | Consumed-ref ack lifecycle (fetch → process → confirm, else redelivery) | `invites` / `joinRequests` / `keyPackages` managers handle ack internally |
| 12 | Authed vs ephemeral channel routing (privacy invariant) | `CordnTransport` + immutable `CHANNEL` table |
| 13 | Three key layers (identity / ephemeral transport / MLS leaf) | `CordnSigner` + SDK ephemeral keypair + `keyPackageStorage` |
| 14 | Coordinator health / reconnect / write-target (spec §2) | `coordinators` manager |
| 15 | Versioned storage blob (forward migrations) | `SerializedGroupBlob.version` |

## Inboxes: primitives, not loops (decisions #7, #8)

- **Welcome & join-request queues** are discrete fetches. The SDK exposes correct, typed primitives (`invites.fetch()`, `joinRequests.fetch()`, `joinRequests.store()`), with consumed-ref ack and publication-payload verification handled internally. **The app decides cadence** — no timers, backoff, or polling policy is imposed.
- **Group-message sync** is continuous per-group state with cursor invariants, so the SDK *also* offers an opt-in `group.runInbox()` runner (fetch-first → cursor advance → subscribe → unified ingest → reconnect-with-resume). Raw `fetch`/`subscribe` primitives remain for apps that want full control.

## Testing strategy

- The SDK dogfoods its own `@cordn/sdk/testing` `InProcessTransport` (backed by `@cordn/coordinator` in-memory or sqlite storage) — the entire engine + client suite runs **end-to-end with zero Nostr, zero network**.
- Injectable `clock`/`timers` give deterministic lifecycle and retry tests.
- Storage parity tests (per AGENTS.md) extend to the SDK's `SerializedGroupBlob` round-trips across `InMemoryKeyValueStore` and any app-supplied backend.
- The existing `packages/cli/src/*.integration.test.ts` flows become the SDK's acceptance tests, ported off the CLI's hand-rolled plumbing onto the new facade.

## Phased extraction plan

1. **Core relocation (decision #11).** Move the metadata-extension codec into `@cordn/core`. Add consumed-ref / publication-payload helpers if not already exported. No behavior change.
2. **Scaffold `packages/sdk`.** Subpath exports, `tsconfig.json` paths, workspace declaration, `ts-mls` re-export barrel.
3. **Engine.** Port `ClientState` ownership, lifecycle, `send`/`ingest`/`confirmPublished`, and convert the four CLI error-classifier functions into typed dispositions. Tests via fake transport.
4. **Transport seam + testing transport.** Define `CordnTransport`; implement `InProcessTransport` over `@cordn/coordinator`. Port the immutable `CHANNEL` routing table from `packages/cli/src/coordinatorClient.ts`.
5. **Client + managers.** `CordnClient`, `KeyPackageManager`, `GroupsManager`, `InviteManager`, `JoinRequestManager`, `CoordinatorManager`. Proposal/action builders.
6. **Storage + `extra`.** `KeyValueStore<T>`, `InMemoryKeyValueStore`, versioned `SerializedGroupBlob`.
7. **Production transport.** `ContextVmTransport` over `@contextvm/sdk` in `/extra`.
8. **Migration.** Port `packages/cli/src/session.ts` and cordn-web's `services/chat*` onto the facade; delete the hand-rolled plumbing.

Each phase ships green (`pnpm run typecheck` + targeted `vitest`) before the next begins.

## Non-goals (explicitly deferred)

Full convergence / fork-recovery / fork trees; multi-device sync (key-package-per-device stays *possible*, sync built later); granular typed `StorageProvider`; framework-specific reactive bindings; audit/forensics sink; a streaming `Subscribe*Welcomes` coordinator method (v1 inbox is fetch-based by design).
