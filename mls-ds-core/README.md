# `mls-ds-core`

Minimal Rust core for a blind MLS delivery service.

It follows the narrow delivery-service shape used by the OpenMLS DS in [`openmls/delivery-service/ds/README.md`](../openmls/delivery-service/ds/README.md):

- register clients
- list clients
- publish and consume key packages
- store and fetch welcome messages
- post and fetch group messages

## Design intent

This crate is the coordinator core only.

- stable identities are used for registration, discovery, and key-package lookup
- welcomes are targeted by stable identity plus reserved key-package reference
- post-welcome traffic uses delivery addresses rather than stable identities
- the coordinator stores opaque payloads and only enforces minimal routing and epoch rules

The crate does **not** implement MLS cryptography, message parsing, or a transport server.

## Main types

- [`BlindCoordinator`](src/lib.rs) keeps the in-memory state model
- [`DeliveryService`](src/lib.rs) exposes DS-style methods for callers
- [`SqliteCoordinatorStore`](src/lib.rs) persists coordinator state in SQLite
- [`KeyPackage`](src/lib.rs) is a thin alias for [`(KeyPackageRef, KeyPackageIn)`](src/lib.rs:42)

## Service surface

The main API is [`DeliveryService`](src/lib.rs), which exposes:

- `register_client`
- `list_clients`
- `publish_key_packages`
- `get_key_packages`
- `consume_key_package`
- `put_group_route`
- `send_welcome`
- `recv_welcomes`
- `send_message`
- `recv_messages`

This keeps the Rust side close to the OpenMLS DS shape while staying aligned with the MVP plan in [`plans/mls-delivery-service-mvp-design.md`](../plans/mls-delivery-service-mvp-design.md).

## Storage model

Persistence uses a single SQLite snapshot table.

That is intentionally simple for the MVP:

- low schema complexity
- easy local development
- one place to persist coordinator state

The snapshot is stored as a binary blob encoded with `bincode`, which avoids JSON limitations around byte-vector keyed maps.

## Minimal example

```rust
use mls_ds_core::{DeliveryService, IdentityRecord, SqliteCoordinatorStore};
use openmls::prelude::{KeyPackageIn, KeyPackageRef};

let store = SqliteCoordinatorStore::open_in_memory()?;
let mut ds = DeliveryService::open(store)?;

ds.register_client(IdentityRecord {
    stable_identity: "npub1alice".into(),
    delivery_addresses: vec!["ephemeral-alice-1".into()],
})?;

ds.publish_key_packages(
    "npub1alice",
    [(
        KeyPackageRef::from_slice(&[1, 2, 3]),
        KeyPackageIn::from(todo!("build a real OpenMLS KeyPackage")),
    )],
)?;
```

In practice, callers should construct real OpenMLS key packages and hash references, as shown in the test helpers under [`mls-ds-core/src/test_support.rs`](src/test_support.rs).

## Testing

Run:

```bash
cargo test -p mls-ds-core
```

The tests cover client registration, key-package lifecycle, welcome flow, epoch rejection, message routing, and SQLite persistence.
