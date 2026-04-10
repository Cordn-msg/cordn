# `mls-ds-cvm`

TypeScript ContextVM wrapper for the Rust MLS delivery service bridge.

## Role in the monorepo

- [`mls-ds-core`](../mls-ds-core) owns coordinator logic and SQLite persistence
- [`mls-ds-server`](../mls-ds-server) exposes the JSON subprocess bridge
- [`mls-ds-cvm`](.) exposes that bridge as ContextVM tools over Nostr

## Environment

- `CVM_PRIVATE_KEY`: required Nostr private key for the server
- `CVM_RELAY_URLS`: comma-separated relay URLs
- `MLS_DS_DB_PATH`: optional SQLite path passed through to the Rust bridge, defaults to `:memory:`
- `MLS_DS_BRIDGE_COMMAND`: optional override for the Rust bridge command, defaults to `cargo`
- `MLS_DS_BRIDGE_ARGS`: optional override for bridge args, defaults to `run -q -p mls-ds-server`

## Install

```bash
cd mls-ds-cvm && npm install
```

## Run

```bash
cd mls-ds-cvm && npm run dev
```

The wrapper starts the Rust bridge subprocess automatically and exposes the contract from [`plans/mls-ds-api-contract.md`](../plans/mls-ds-api-contract.md) as ContextVM tools.

## Structured outputs

Each tool in [`src/index.ts`](src/index.ts) defines an MCP `outputSchema` and returns validated `structuredContent` for programmatic use.

- Stable machine-readable payloads are returned in `structuredContent`
- Output validation is enforced in the wrapper before the tool response is returned

Current result shapes:

- `bridge_info` → `{ status, contract, bridge, database_path }`
- `register_client` → `{ registered }`
- `list_clients` → `{ clients: IdentityRecord[] }`
- `publish_key_packages` → `{ published }`
- `get_key_packages` → `{ key_packages: KeyPackage[] }`
- `consume_key_package` → `{ key_package: KeyPackage }`
- `put_group_route` → `{ stored }`
- `send_welcome` → `{ stored }`
- `recv_welcomes` → `{ welcomes: WelcomeMessage[] }`
- `send_message` → `{ stored }`
- `recv_messages` → `{ messages: GroupMessage[] }`

This makes [`mls-ds-cvm`](.) suitable for agents and other automated clients that need stable response contracts instead of parsing text output.

## End-to-end local workflow

1. Build or test the Rust bridge:

```bash
cargo test -p mls-ds-server
```

2. Install the TypeScript wrapper dependencies:

```bash
cd mls-ds-cvm && npm install
```

3. Start the ContextVM wrapper:

```bash
cd mls-ds-cvm && CVM_PRIVATE_KEY=<hex-private-key> npm run dev
```

4. Optional persistent storage for the Rust bridge:

```bash
cd mls-ds-cvm && MLS_DS_DB_PATH=../mls-ds.sqlite CVM_PRIVATE_KEY=<hex-private-key> npm run dev
```

By default the wrapper launches [`mls-ds-server`](../mls-ds-server) through `cargo run -q -p mls-ds-server` and uses in-memory storage.

## Manual relay-backed e2e scenario

[`src/e2e/manual-e2e.ts`](src/e2e/manual-e2e.ts) is now a minimal progressive harness against a real relay.

Current first step:

- starts the real ContextVM server process from [`src/index.ts`](src/index.ts)
- connects one independent ContextVM client over `wss://relay.contextvm.org`
- calls `bridge_info`
- validates the structured response
- exits cleanly

Run it with:

```bash
cd mls-ds-cvm && npm run e2e
```

Notes:

- this is intended as a manual integration check, not a CI test
- the script creates fresh temporary keys and a temporary SQLite database for each run
- the relay is fixed in [`src/e2e/harness.ts`](src/e2e/harness.ts) to `wss://relay.contextvm.org` unless you change it there
- this is the starting point for progressively adding more e2e steps after the basic server/client round-trip is confirmed

## Exposed tools

- `bridge_info`
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
