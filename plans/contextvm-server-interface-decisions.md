# ContextVM Server Interface Decisions for the MLS Delivery Service

## Status

Accepted for the next implementation iteration.

## Goal

Document the agreed ContextVM server boundary so the next iteration can implement the server adapter and tests without re-deciding transport details.

## Core Decision

The ContextVM server should expose a thin, typed, JSON-safe RPC surface over the existing blind coordinator in [`src/coordinator/deliveryServiceCoordinator.ts`](../src/coordinator/deliveryServiceCoordinator.ts).

The server layer should:

- use injected ContextVM client pubkeys as the caller identity source
- transport MLS binary artifacts as base64 strings
- use structured outputs only
- keep the coordinator transport-agnostic

## Identity Handling

### Use injected client pubkeys

The server should enable `injectClientPubkey` as described in [`.agents/skills/server-dev/SKILL.md`](../.agents/skills/server-dev/SKILL.md:124).

The tool handlers should read `_meta.clientPubkey` and map it into the coordinator inputs.

This means the ContextVM server should not expose caller-supplied identity fields for operations where identity can be inferred from the authenticated transport envelope.

### Consequences for tool inputs

The following fields should **not** appear in the ContextVM tool input schemas:

- `stablePubkey` for key package publication
- `targetStablePubkey` for fetching pending welcomes
- `ephemeralSenderPubkey` for posting group messages

These values should instead be inferred from `_meta.clientPubkey` in the server adapter layer.

## Binary Transport Encoding

### Use base64 by schema

MLS artifacts must cross the ContextVM tool boundary as base64 strings.

This applies to:

- serialized key packages
- serialized welcomes
- serialized MLS group messages

The schema itself should define the encoding through field names such as:

- `keyPackageBase64`
- `welcomeBase64`
- `opaqueMessageBase64`

### Do not add an explicit encoding field

The ContextVM server controls the tool schemas, so an additional `encoding` field is unnecessary for the MVP.

Unlike looser event-level interoperability documents such as [`marmot/02.md`](../marmot/02.md:53), this server interface can assume a single encoding defined by the schema.

## Structured Outputs Only

The ContextVM server should expose a typed API using structured outputs as described in [`.agents/skills/server-dev/SKILL.md`](../.agents/skills/server-dev/SKILL.md:171).

Each tool should:

- define an `inputSchema`
- define an `outputSchema`
- return `structuredContent`
- return `content: []`

Human-oriented text responses are not the goal for this server surface.

## Layering Rules

### ContextVM server layer owns

- reading `_meta.clientPubkey`
- validating required injected metadata is present
- decoding base64 inputs into bytes
- encoding byte outputs back into base64
- mapping between RPC DTOs and coordinator-native types

### Coordinator layer owns

- key package publication and retrieval
- welcome storage and delivery
- group message queueing
- cursor-based fetch
- minimal MLS structural decoding for routing and stale-handshake rejection

The coordinator should remain transport-agnostic and continue to operate on byte arrays and domain records defined in [`src/coordinator/types.ts`](../src/coordinator/types.ts).

## Recommended Tool Shapes

### `publish_key_package`

Input:

- `keyPackageRef: string`
- `keyPackageBase64: string`

Derived by server:

- `stablePubkey` from `_meta.clientPubkey`

Structured output:

- `keyPackageId: string`
- `keyPackageRef: string`
- `publishedAt: number`

### `consume_key_package_for_identity`

Input:

- `stablePubkey: string`

Structured output:

- `keyPackageId: string`
- `stablePubkey: string`
- `keyPackageRef: string`
- `keyPackageBase64: string`
- `publishedAt: number`

This tool intentionally accepts an explicit target identity because invitation flows need to retrieve another user’s published key package.

### `fetch_pending_welcomes`

Input:

- no identity field

Derived by server:

- `targetStablePubkey` from `_meta.clientPubkey`

Structured output:

- `welcomes: Array<{ welcomeId: string; keyPackageReference: string; welcomeBase64: string; createdAt: number }>`

### `store_welcome`

Input:

- `targetStablePubkey: string`
- `keyPackageReference: string`
- `welcomeBase64: string`

Structured output:

- `welcomeId: string`
- `createdAt: number`

The target stable identity must remain explicit here because the caller is storing a welcome for another user.

### `post_group_message`

Input:

- `opaqueMessageBase64: string`

Derived by server:

- `ephemeralSenderPubkey` from `_meta.clientPubkey`

Structured output:

- `cursor: number`
- `groupId: string`
- `createdAt: number`

### `fetch_group_messages`

Input:

- `groupId: string`
- `afterCursor?: number`

Structured output:

- `messages: Array<{ cursor: number; groupId: string; opaqueMessageBase64: string; createdAt: number }>`

## Security and Privacy Notes

- The server should reject posting or self-scoped identity operations when `_meta.clientPubkey` is missing.
- Caller identity for self-scoped operations should come only from injected transport metadata, never from caller-controlled JSON fields.
- ContextVM encrypted traffic reduces observer visibility, which makes injected client pubkeys an acceptable MVP identity source for self-scoped operations.

## Testing Implications

The next server-focused test wave should include:

- base64 decode/encode round-trips for every binary field
- rejection of invalid base64 inputs
- rejection when `_meta.clientPubkey` is missing on self-scoped operations
- confirmation that tool handlers correctly map injected client identity into coordinator calls
- structured output shape validation for each tool

## Implementation Order

1. define transport DTO types for the ContextVM server
2. add base64 helper utilities
3. implement the ContextVM server adapter around [`DeliveryServiceCoordinator`](../src/coordinator/deliveryServiceCoordinator.ts:74)
4. register tools with `inputSchema` and `outputSchema`
5. return `structuredContent` with `content: []`
6. add server-boundary tests
