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
- Storage backends must preserve parity for this behavior, including [`InMemoryCoordinatorStorage`](src/coordinator/storage/inMemoryStorage.ts:38) and [`SqliteCoordinatorStorage`](src/coordinator/storage/sqliteStorage.ts:104).

## Run the server

Start the runnable entrypoint:

```bash
pnpm run dev
```

Runtime configuration is loaded from [`.env.example`](.env.example) keys using the `CORDN_` prefix, including `CORDN_SERVER_PRIVATE_KEY`, `CORDN_RELAY_URLS`, `CORDN_STORAGE_BACKEND`, and `CORDN_SQLITE_PATH`.
