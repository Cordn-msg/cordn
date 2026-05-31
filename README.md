# Cordn

Minimal MLS delivery service coordinator and ContextVM server adapter implemented in TypeScript on top of [`ts-mls`](ts-mls/README.md).

[`cordn`](package.json) includes both protocol documentation and executable reference code:

- [`spec/00.md`](spec/00.md) defines the baseline coordinator and identity model.
- [`spec/01.md`](spec/01.md) defines the initial group metadata extension.
- [`spec/02.md`](spec/02.md) defines the Nostr-shaped application-message envelope model.
- [`src/coordinator/`](src/coordinator/) contains the reference coordinator implementation.
- [`src/server/`](src/server/) exposes that coordinator as a runnable ContextVM server.
- [`src/cli/`](src/cli/) contains a demo CLI used to demonstrate end-to-end usage and interaction patterns.
- The same CLI and server flow is also used by the integration-style test coverage under [`src/`](src/).

## Coordinator delivery semantics

- Group message cursors are monotonic per group, not global across all groups.
- [`fetchGroupMessages({ groupId, afterCursor })`](src/coordinator/coordinator.ts:160) interprets `afterCursor` relative to the specified group only.
- [`subscribeGroupMessages({ groupId, afterCursor })`](src/coordinator/coordinator.ts:265) uses the same per-group cursor model, replaying backlog first and then keeping the stream open for live delivery.
- [`FetchManyGroupMessages`](src/cli/coordinatorClient.ts:342) performs bounded catch-up for multiple groups while preserving independent per-group cursor semantics.
- [`SubscribeManyGroupMessages`](src/cli/coordinatorClient.ts:371) opens one CEP-41 stream for multiple groups while preserving independent `afterCursor` semantics per group.
- Storage backends must preserve parity for this behavior, including [`InMemoryCoordinatorStorage`](src/coordinator/storage/inMemoryStorage.ts:38) and [`SqliteCoordinatorStorage`](src/coordinator/storage/sqliteStorage.ts:104).
- [`cordn`](package.json) supports last-resort MLS KeyPackages, deriving `isLastResort` from the KeyPackage extension rather than trusting an out-of-band publish flag.
- Stable-identity KeyPackage consumption prefers regular KeyPackages first and falls back to last-resort KeyPackages without consuming them.
- The CLI [`gen-kp`](src/cli/replCommands.ts:188) command can generate and publish last-resort KeyPackages, and [`delete-kp`](src/cli/replCommands.ts:205) can explicitly remove published KeyPackages.

Active clients should prefer a fetch-then-subscribe flow:

1. call [`FetchGroupMessages`](src/cli/coordinatorClient.ts:258) for bounded catch-up
2. then call [`SubscribeGroupMessages`](src/cli/coordinatorClient.ts:269) from the freshest known cursor for CEP-41 live delivery

Clients tracking many groups should use [`FetchManyGroupMessages`](src/cli/coordinatorClient.ts:342) for bounded catch-up before opening [`SubscribeManyGroupMessages`](src/cli/coordinatorClient.ts:390). The stream emits the same group-message records as the single-group subscription, including `gid`, so clients should demultiplex by group and advance each local cursor independently.

The reference client logic in [`src/cli/`](src/cli/) is intentionally opinionated about synchronization strategy:

- fetch backlog first, then open the live subscription
- feed both fetch and live stream records through one shared ingestion pipeline
- reconcile self-authored echoed ciphertext by identity instead of reprocessing it through MLS
- finalize pending local epoch operations only after the matching inbound commit is observed

These rules are documented in more detail in [`src/cli/README.md`](src/cli/README.md:54).

## Run the server locally

Start the runnable entrypoint:

```bash
pnpm run dev
```

Runtime configuration is loaded from [`.env.example`](.env.example) keys using the `CORDN_` prefix, including `CORDN_SERVER_PRIVATE_KEY`, `CORDN_RELAY_URLS`, `CORDN_STORAGE_BACKEND`, and `CORDN_SQLITE_PATH`.

Basic anti-abuse protection is enabled by default in [`src/server/`](src/server/) with a homogeneous token bucket keyed by injected client pubkey. Operators can tune it with `CORDN_RATE_LIMIT_ENABLED`, `CORDN_RATE_LIMIT_REFILL_PER_MINUTE`, `CORDN_RATE_LIMIT_BURST`, and `CORDN_RATE_LIMIT_IDLE_TTL_SECONDS`.

Key package storage quotas are also configurable per stable identity. `CORDN_MAX_KEY_PACKAGES_PER_IDENTITY` limits the total number of published key packages per identity, and `CORDN_MAX_LAST_RESORT_KEY_PACKAGES_PER_IDENTITY` limits retained last-resort key packages. When the last-resort quota is reached, publishing a new last-resort key package replaces the oldest retained one instead of failing.

The runnable server enables both CEP-22 oversized transfer and CEP-41 open streams in [`connectServer()`](src/server/coordinatorServer.ts:40).

## Deploy with Docker

The recommended deployment story is Docker, using the published container image from GitHub Container Registry:

```bash
docker pull ghcr.io/cordn-msg/cordn:latest
docker run --rm \
  -e CORDN_SERVER_PRIVATE_KEY=<your-64-hex-private-key> \
  ghcr.io/cordn-msg/cordn:latest
```

### Quick local test

The most minimal run is:

```bash
docker run --rm ghcr.io/cordn-msg/cordn:latest
```

That starts the bundled server entrypoint from [`dist/main.js`](dist/). If no `CORDN_SERVER_PRIVATE_KEY` is provided, the server generates a fresh key for that process only. Because this command is ephemeral and does not provide persistent key material, the generated key is not preserved across restarts.

For a repeatable local test, provide your own key explicitly:

```bash
docker run --rm \
  -e CORDN_SERVER_PRIVATE_KEY=<your-64-hex-private-key> \
  -e CORDN_ANNOUNCED=false \
  ghcr.io/cordn-msg/cordn:latest
```

By default, the container now uses in-memory storage through [`CORDN_STORAGE_BACKEND=memory`](Dockerfile:28). That keeps quick local runs simple and avoids creating SQLite state unless you opt into it.

### Persistent deployment

For a persistent deployment, switch the container to SQLite storage and mount `/data`:

```bash
docker run -d \
  --name cordn \
  --restart unless-stopped \
  -v cordn-data:/data \
  -e CORDN_SERVER_PRIVATE_KEY=<your-64-hex-private-key> \
  -e CORDN_STORAGE_BACKEND=sqlite \
  -e CORDN_SQLITE_PATH=/data/cordn.sqlite \
  -e CORDN_RELAY_URLS=wss://relay.contextvm.org \
  -e CORDN_ANNOUNCED=true \
  -e CORDN_SERVER_NAME=cordn-server \
  ghcr.io/cordn-msg/cordn:latest
```

Recommended minimum environment variables:

- `CORDN_SERVER_PRIVATE_KEY`: required server signing key
- `CORDN_RELAY_URLS`: comma-separated relay list
- `CORDN_ANNOUNCED`: set to `true` for a publicly announced server
- `CORDN_SERVER_NAME`: optional human-readable name

Useful persistence and runtime defaults from [`Dockerfile`](Dockerfile):

- [`CORDN_STORAGE_BACKEND=memory`](Dockerfile:28)
- [`VOLUME ["/data"]`](Dockerfile:43)

For persistent deployments, override storage with `CORDN_STORAGE_BACKEND=sqlite` and set `CORDN_SQLITE_PATH=/data/cordn.sqlite`.

### Example with additional abuse-protection tuning

```bash
docker run -d \
  --name cordn \
  --restart unless-stopped \
  -v cordn-data:/data \
  -e CORDN_SERVER_PRIVATE_KEY=<your-64-hex-private-key> \
  -e CORDN_STORAGE_BACKEND=sqlite \
  -e CORDN_SQLITE_PATH=/data/cordn.sqlite \
  -e CORDN_ANNOUNCED=true \
  -e CORDN_RATE_LIMIT_REFILL_PER_MINUTE=250 \
  -e CORDN_RATE_LIMIT_BURST=80 \
  -e CORDN_MAX_KEY_PACKAGES_PER_IDENTITY=50 \
  -e CORDN_MAX_LAST_RESORT_KEY_PACKAGES_PER_IDENTITY=1 \
  ghcr.io/cordn-msg/cordn:latest
```

### Updating the deployment

To update to the newest published image:

```bash
docker pull ghcr.io/cordn-msg/cordn:latest
docker stop cordn && docker rm cordn
docker run -d \
  --name cordn \
  --restart unless-stopped \
  -v cordn-data:/data \
  -e CORDN_SERVER_PRIVATE_KEY=<your-64-hex-private-key> \
  -e CORDN_STORAGE_BACKEND=sqlite \
  -e CORDN_SQLITE_PATH=/data/cordn.sqlite \
  -e CORDN_ANNOUNCED=true \
  ghcr.io/cordn-msg/cordn:latest
```
