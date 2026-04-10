# MLS DS External API Contract

This document defines the stable boundary between the Rust coordinator core in [`mls-ds-core/src/lib.rs`](../mls-ds-core/src/lib.rs) and the future TypeScript ContextVM wrapper.

It is intentionally narrower than the internal Rust API. The goal is to freeze transport-facing request/response semantics before building the wrapper in [`mls-ds-server/src/main.rs`](../mls-ds-server/src/main.rs).

## Boundary goals

- keep the coordinator logic in Rust
- expose a deterministic request/response contract to TypeScript
- avoid leaking Rust-specific types like [`GroupId`](../openmls/openmls/src/group/mod.rs:67) or [`KeyPackageRef`](../openmls/openmls/src/ciphersuite/hash_ref.rs:92) directly across the boundary
- standardize encodings for all binary MLS fields
- standardize machine-readable error codes

## Bridge shape

For the MVP, the Rust↔TypeScript bridge should be a local JSON subprocess boundary.

- Rust owns state, SQLite persistence, and coordinator rules
- TypeScript owns ContextVM transport and tool schemas
- the wrapper launches a local Rust process and exchanges newline-delimited JSON requests and responses over stdin/stdout

This is preferred over FFI for the MVP because it keeps the language boundary simple and avoids native binding work.

## Encoding rules

All binary fields exposed outside Rust use unpadded base64url.

Reasons:

- matches URL- and JSON-safe transport needs
- avoids hex size inflation
- is straightforward for TypeScript and Rust to encode/decode

### Encoded field mapping

| External field | Internal Rust type | Encoding |
| --- | --- | --- |
| `group_id` | [`GroupId`](../openmls/openmls/src/group/mod.rs:67) | base64url |
| `epoch` | [`GroupEpoch`](../openmls/openmls/src/group/mod.rs:99) | JSON number |
| `key_package_ref` | [`KeyPackageRef`](../openmls/openmls/src/ciphersuite/hash_ref.rs:92) | base64url |
| `key_package` | [`KeyPackageIn`](../openmls/openmls/src/key_packages/key_package_in.rs:110) TLS bytes | base64url |
| `message_bytes` | serialized [`MlsMessageIn`](../openmls/openmls/src/framing/message_in.rs:39) bytes | base64url |

Stable identities and delivery addresses remain UTF-8 strings.

## Operation surface

The external contract mirrors the DS-style surface already exposed by [`DeliveryService`](../mls-ds-core/src/lib.rs:342).

Each request is a JSON object:

```json
{
  "id": "req-123",
  "method": "register_client",
  "params": { }
}
```

Each success response is:

```json
{
  "id": "req-123",
  "ok": true,
  "result": { }
}
```

Each failure response is:

```json
{
  "id": "req-123",
  "ok": false,
  "error": {
    "code": "unknown_identity",
    "message": "identity not found"
  }
}
```

## DTOs

### `IdentityRecord`

```json
{
  "stable_identity": "npub1alice",
  "delivery_addresses": ["ephemeral-alice-1"]
}
```

Maps to [`IdentityRecord`](../mls-ds-core/src/lib.rs:17).

### `KeyPackage`

```json
{
  "key_package_ref": "AQID",
  "key_package": "BASE64URL_TLS_KEY_PACKAGE"
}
```

Maps to [`KeyPackage`](../mls-ds-core/src/lib.rs:45).

### `GroupRoute`

```json
{
  "group_id": "Z3JvdXAtYQ",
  "epoch": 3,
  "members": ["ephemeral-alice-1", "ephemeral-bob-1"]
}
```

Maps to [`GroupRoute`](../mls-ds-core/src/lib.rs:23).

### `WelcomeMessage`

```json
{
  "stable_identity": "npub1alice",
  "key_package_ref": "AQID",
  "message_bytes": "BASE64URL_TLS_WELCOME"
}
```

Maps to [`WelcomeMessage`](../mls-ds-core/src/lib.rs:30).

### `GroupMessage`

```json
{
  "group_id": "Z3JvdXAtYQ",
  "epoch": 4,
  "sender": "ephemeral-alice-1",
  "recipients": ["ephemeral-bob-1"],
  "message_bytes": "BASE64URL_TLS_MLS_MESSAGE"
}
```

Maps to [`GroupMessage`](../mls-ds-core/src/lib.rs:37).

## Methods

### `register_client`

Request:

```json
{
  "stable_identity": "npub1alice",
  "delivery_addresses": ["ephemeral-alice-1"]
}
```

Response:

```json
{ "registered": true }
```

### `list_clients`

Request:

```json
{}
```

Response:

```json
{
  "clients": [
    {
      "stable_identity": "npub1alice",
      "delivery_addresses": ["ephemeral-alice-1"]
    }
  ]
}
```

### `publish_key_packages`

Request:

```json
{
  "stable_identity": "npub1alice",
  "key_packages": [
    {
      "key_package_ref": "AQID",
      "key_package": "BASE64URL_TLS_KEY_PACKAGE"
    }
  ]
}
```

Response:

```json
{ "published": 1 }
```

### `get_key_packages`

Request:

```json
{
  "stable_identity": "npub1alice"
}
```

Response:

```json
{
  "key_packages": [
    {
      "key_package_ref": "AQID",
      "key_package": "BASE64URL_TLS_KEY_PACKAGE"
    }
  ]
}
```

### `consume_key_package`

Request:

```json
{
  "stable_identity": "npub1alice"
}
```

Response:

```json
{
  "key_package": {
    "key_package_ref": "AQID",
    "key_package": "BASE64URL_TLS_KEY_PACKAGE"
  }
}
```

### `put_group_route`

Request:

```json
{
  "group_id": "Z3JvdXAtYQ",
  "epoch": 3,
  "members": ["ephemeral-alice-1", "ephemeral-bob-1"]
}
```

Response:

```json
{ "stored": true }
```

### `send_welcome`

Request:

```json
{
  "stable_identity": "npub1alice",
  "key_package_ref": "AQID",
  "message_bytes": "BASE64URL_TLS_WELCOME"
}
```

Response:

```json
{ "stored": true }
```

### `recv_welcomes`

Request:

```json
{
  "stable_identity": "npub1alice"
}
```

Response:

```json
{
  "welcomes": [
    {
      "stable_identity": "npub1alice",
      "key_package_ref": "AQID",
      "message_bytes": "BASE64URL_TLS_WELCOME"
    }
  ]
}
```

### `send_message`

Request:

```json
{
  "group_id": "Z3JvdXAtYQ",
  "epoch": 4,
  "sender": "ephemeral-alice-1",
  "recipients": ["ephemeral-bob-1"],
  "message_bytes": "BASE64URL_TLS_MLS_MESSAGE"
}
```

Response:

```json
{ "stored": true }
```

### `recv_messages`

Request:

```json
{
  "delivery_address": "ephemeral-bob-1"
}
```

Response:

```json
{
  "messages": [
    {
      "group_id": "Z3JvdXAtYQ",
      "epoch": 4,
      "sender": "ephemeral-alice-1",
      "recipients": ["ephemeral-bob-1"],
      "message_bytes": "BASE64URL_TLS_MLS_MESSAGE"
    }
  ]
}
```

## Error mapping

Rust errors from [`CoordinatorError`](../mls-ds-core/src/lib.rs:62) map to stable external codes.

| Rust variant | External code | Notes |
| --- | --- | --- |
| `UnknownGroup` | `unknown_group` | caller error |
| `UnknownIdentity` | `unknown_identity` | caller error |
| `StaleEpoch` | `stale_epoch` | caller error; include `expected` and `received` |
| `SenderNotMember` | `sender_not_member` | caller error |
| `NoKeyPackageAvailable` | `no_key_package_available` | caller error |
| `UnknownWelcomeKeyPackage` | `unknown_welcome_key_package` | caller error |
| `TlsDeserialize` | `invalid_mls_bytes` | malformed caller input |
| `Storage` | `storage_error` | server error |
| `BinaryEncode` | `internal_encoding_error` | server error |
| `BinaryDecode` | `internal_decoding_error` | server error |

For `stale_epoch`, the response error object should include details:

```json
{
  "code": "stale_epoch",
  "message": "stale epoch: expected at least 3, got 2",
  "details": {
    "expected": 3,
    "received": 2
  }
}
```

## Concurrency and persistence expectations

The MVP assumes a single Rust process owns the SQLite-backed coordinator.

- operations are serialized through the Rust service instance
- SQLite persistence is snapshot-based via [`SqliteCoordinatorStore`](../mls-ds-core/src/lib.rs:259)
- the TypeScript wrapper should treat the Rust subprocess as the single writer
- concurrent tool calls should be queued by the wrapper unless and until the Rust boundary is upgraded explicitly

## Role of `mls-ds-server`

The crate in [`mls-ds-server`](../mls-ds-server) should become the thin Rust bridge process that:

- accepts JSON requests on stdin
- calls [`DeliveryService`](../mls-ds-core/src/lib.rs:342)
- returns JSON responses on stdout
- performs base64url decoding/encoding at the boundary

It should not grow a second coordinator model or a parallel transport abstraction.
