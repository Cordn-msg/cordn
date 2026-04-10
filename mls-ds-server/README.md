# `mls-ds-server`

Thin Rust bridge process for the MLS delivery service MVP.

Its role is defined by [`plans/mls-ds-api-contract.md`](../plans/mls-ds-api-contract.md):

- own the Rust-side subprocess boundary
- exchange newline-delimited JSON over stdin/stdout
- translate between transport DTOs and [`mls-ds-core`](../mls-ds-core)
- stay thin and avoid duplicating coordinator logic

## Current status

The crate currently provides a minimal JSON bridge stub in [`src/main.rs`](src/main.rs) so the repository has an explicit place for the Rust boundary process.

Implemented now:

- request envelope parsing
- success/error response envelopes
- a `bridge_info` method for wrapper handshake and smoke tests
- deterministic `unsupported_method` errors for everything else

Not implemented yet:

- wiring to [`DeliveryService`](../mls-ds-core/src/lib.rs:342)
- base64url DTO decoding and encoding
- persistence configuration
- full method coverage from [`plans/mls-ds-api-contract.md`](../plans/mls-ds-api-contract.md)

## Monorepo layout

- [`mls-ds-core`](../mls-ds-core) contains the coordinator state model and persistence
- [`mls-ds-server`](.) is the Rust bridge process boundary
- the future TypeScript ContextVM wrapper should sit above this bridge and consume the contract from [`plans/mls-ds-api-contract.md`](../plans/mls-ds-api-contract.md)

## Local smoke test

```bash
printf '%s\n' '{"id":"1","method":"bridge_info","params":{}}' | cargo run -p mls-ds-server
```
