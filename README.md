# Cordn

Minimal MLS delivery service coordinator and ContextVM server adapter implemented in TypeScript on top of [`ts-mls`](ts-mls/README.md).

[`cordn`](package.json) includes both protocol documentation and executable reference code:

- [`spec/00.md`](spec/00.md) defines the baseline coordinator and identity model.
- [`spec/01.md`](spec/01.md) defines the initial group metadata extension.
- [`src/coordinator/`](src/coordinator/) contains the reference coordinator implementation.
- [`src/server/`](src/server/) exposes that coordinator as a runnable ContextVM server.
- [`src/cli/`](src/cli/) contains a demo CLI used to demonstrate end-to-end usage and interaction patterns.
- The same CLI and server flow is also used by the integration-style test coverage under [`src/`](src/).

## Coordinator delivery semantics

- Group message cursors are monotonic per group, not global across all groups.
- [`fetchGroupMessages({ groupId, afterCursor })`](src/coordinator/coordinator.ts:160) interprets `afterCursor` relative to the specified group only.
- [`subscribeGroupMessages({ groupId, afterCursor })`](src/coordinator/coordinator.ts:265) uses the same per-group cursor model, replaying backlog first and then keeping the stream open for live delivery.
- Storage backends must preserve parity for this behavior, including [`InMemoryCoordinatorStorage`](src/coordinator/storage/inMemoryStorage.ts:38) and [`SqliteCoordinatorStorage`](src/coordinator/storage/sqliteStorage.ts:104).
- [`cordn`](package.json) supports last-resort MLS KeyPackages, deriving `isLastResort` from the KeyPackage extension rather than trusting an out-of-band publish flag.
- Stable-identity KeyPackage consumption prefers regular KeyPackages first and falls back to last-resort KeyPackages without consuming them.
- The CLI [`gen-kp`](src/cli/replCommands.ts:188) command can generate and publish last-resort KeyPackages, and [`delete-kp`](src/cli/replCommands.ts:205) can explicitly remove published KeyPackages.

Active clients should prefer a fetch-then-subscribe flow:

1. call [`FetchGroupMessages`](src/cli/coordinatorClient.ts:258) for bounded catch-up
2. then call [`SubscribeGroupMessages`](src/cli/coordinatorClient.ts:269) from the freshest known cursor for CEP-41 live delivery

## Run the server

Start the runnable entrypoint:

```bash
pnpm run dev
```

Runtime configuration is loaded from [`.env.example`](.env.example) keys using the `CORDN_` prefix, including `CORDN_SERVER_PRIVATE_KEY`, `CORDN_RELAY_URLS`, `CORDN_STORAGE_BACKEND`, and `CORDN_SQLITE_PATH`.

The runnable server enables both CEP-22 oversized transfer and CEP-41 open streams in [`connectServer()`](src/server/coordinatorServer.ts:40).
