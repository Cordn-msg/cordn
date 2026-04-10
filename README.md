# [`cvm-mls`](README.md)

Minimal MLS delivery service and ContextVM server adapter implemented in TypeScript on top of [`ts-mls`](ts-mls/README.md).

## What is implemented

- blind in-memory coordinator in [`DeliveryServiceCoordinator`](src/coordinator/deliveryServiceCoordinator.ts:75)
- ContextVM adapter with typed tool schemas in [`ContextVmCoordinatorAdapter`](src/server/contextvmCoordinatorAdapter.ts:147)
- server factory and Nostr transport wiring in [`createContextVmCoordinatorServer()`](src/server/contextvmCoordinatorServer.ts:39) and [`connectContextVmCoordinatorServer()`](src/server/contextvmCoordinatorServer.ts:56)
- runnable server entrypoint in [`src/server/main.ts`](src/server/main.ts)

## Tool surface

The ContextVM server registers the following tools via [`registerCoordinatorContextVmTools()`](src/server/contextvmCoordinatorAdapter.ts:258):

- `publish_key_package`
- `consume_key_package_for_identity`
- `fetch_pending_welcomes`
- `store_welcome`
- `post_group_message`
- `fetch_group_messages`

All binary MLS artifacts cross the RPC boundary as base64 strings. The conversion helpers live in [`decodeBase64()`](src/server/base64.ts:1) and [`encodeBase64()`](src/server/base64.ts:16).

Self-scoped operations derive caller identity from injected ContextVM transport metadata instead of caller-supplied JSON fields, following [`plans/contextvm-server-interface-decisions.md`](plans/contextvm-server-interface-decisions.md).

## Run the server

Start the runnable entrypoint:

```bash
pnpm run server:start
```

This executes [`src/server/main.ts`](src/server/main.ts), which:

- loads optional values from `.env` and `.env.local` before reading process environment variables
- creates the coordinator server
- configures [`NostrServerTransport`](src/server/contextvmCoordinatorServer.ts:69)
- uses an explicit private key if configured
- otherwise generates an ephemeral signer through [`createDefaultServerSigner()`](src/server/contextvmCoordinatorServer.ts:30)

## Optional environment variables

All runtime environment variables are optional.

If present, `.env` is loaded first and `.env.local` is loaded after it. Existing shell environment variables still take precedence over file-based values.

- `CVM_MLS_SERVER_PRIVATE_KEY`
  - hex private key for a stable server identity
  - if omitted, the server generates an ephemeral signer
- `CVM_MLS_RELAY_URLS`
  - comma-separated relay URLs
  - if omitted, defaults come from [`getDefaultRelayUrls()`](src/server/contextvmCoordinatorServer.ts:34)
- `CVM_MLS_SERVER_NAME`
  - advertised server name
- `CVM_MLS_SERVER_ABOUT`
  - advertised server description
- `CVM_MLS_SERVER_WEBSITE`
  - advertised server website
- `CVM_MLS_ANNOUNCED`
  - `true` or `false`
  - defaults to `false`

Example:

```bash
CVM_MLS_ANNOUNCED=true \
CVM_MLS_SERVER_NAME="MLS Delivery Service" \
CVM_MLS_RELAY_URLS="wss://relay.contextvm.org,wss://cvm.otherstuff.ai" \
pnpm run server:start
```

## Programmatic usage

Create a server without connecting transport:

```ts
import { createContextVmCoordinatorServer } from "cvm-mls"

const { server, coordinator } = createContextVmCoordinatorServer()
```

Connect a transport directly:

```ts
import { connectContextVmCoordinatorServer } from "cvm-mls"

await connectContextVmCoordinatorServer({
  relayUrls: ["wss://relay.contextvm.org"],
})
```

If no signer is provided, [`connectContextVmCoordinatorServer()`](src/server/contextvmCoordinatorServer.ts:56) creates an ephemeral one automatically.

## Interactive CLI MVP

Run the minimal in-memory CLI:

```bash
pnpm run client:cli
```

Optional startup flags:

- `--private-key <hex>` to reuse a stable client identity
- `--server-pubkey <hex>` to target a specific coordinator server; if omitted, the CLI uses [`CvmMlsDeliveryServiceClient.SERVER_PUBKEY`](src/client/ctxcn/CvmMlsDeliveryServiceClient.ts:91)
- `--relay <url>` to add one or more relay URLs; if omitted, the CLI uses [`CvmMlsDeliveryServiceClient.DEFAULT_RELAYS`](src/client/ctxcn/CvmMlsDeliveryServiceClient.ts:92)

The CLI entrypoint lives in [`src/client/cli/main.ts`](src/client/cli/main.ts) and uses [`commander`](package.json:21) for argument parsing. The interactive shell lives in [`src/client/cli/repl.ts`](src/client/cli/repl.ts), while the in-memory MLS/session state lives in [`CliSession`](src/client/cli/session.ts:58).

### Supported CLI commands

- `help`
- `status`
- `whoami`
- `gen-kp [alias]`
- `key-packages`
- `publish-kp <alias>`
- `available-kps`
- `create-group <alias> [keyPackageAlias]`
- `groups`
- `group <groupAlias>`
- `use <groupAlias>`
- `leave`
- `add-member <groupAlias> <targetStablePubkey>`
- `fetch-welcomes`
- `welcomes`
- `accept-welcome <welcomeId> [groupAlias]`
- `send <message...>`
- `send-to <groupAlias> <message...>`
- `sync [groupAlias]`
- `sync-all`
- `messages [groupAlias]`
- `issues [groupAlias]`
- `exit`

Selected-group quality-of-life behavior:

- pressing Enter on an empty line runs sync for the selected group
- typing plain text without a command sends it to the selected group
- `group` or `use` re-enters an existing group context
- `leave` clears the current group context without exiting the CLI
- `messages` shows the full in-memory chat history for the group

When the local client later fetches its own already-applied commit or proposal, the CLI now advances beyond that cursor and records the event under `issues` instead of aborting the sync loop.

You can now inspect invitation targets in-band with `available-kps`, which lists currently published coordinator key packages by stable pubkey and key package reference before calling `add-member`.

### Minimal two-terminal manual flow

1. Start the server with [`pnpm run server:start`](package.json:10).
2. Open terminal A and run [`pnpm run client:cli`](package.json:9).
3. Open terminal B and run [`pnpm run client:cli`](package.json:9).
4. In both terminals, run `whoami` and copy the stable pubkeys.
5. In terminal B:
   - run `gen-kp bob-main`
   - run `publish-kp bob-main`
6. In terminal A:
   - run `gen-kp alice-main`
   - run `create-group demo alice-main`
   - run `add-member demo <bob-stable-pubkey>`
7. In terminal B:
   - run `fetch-welcomes`
   - run `accept-welcome <welcomeId> demo`
8. Exchange messages:
   - terminal A: `send hello bob`
   - terminal B: press Enter
   - terminal B: type `hello alice`
   - terminal A: press Enter

The CLI is intentionally ephemeral for MVP iteration: all key packages, welcomes, group state, selected group context, and message history stay in memory only.

## Validation

The current implementation is covered by:

- coordinator unit tests in [`src/coordinator/deliveryServiceCoordinator.test.ts`](src/coordinator/deliveryServiceCoordinator.test.ts:27)
- coordinator integration tests in [`src/coordinator/deliveryServiceCoordinator.integration.test.ts`](src/coordinator/deliveryServiceCoordinator.integration.test.ts:18)
- server adapter tests in [`src/server/contextvmCoordinatorAdapter.test.ts`](src/server/contextvmCoordinatorAdapter.test.ts:46)
- client CLI integration tests in [`src/client/cli/session.integration.test.ts`](src/client/cli/session.integration.test.ts:9)

Validation commands:

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm vitest run ./src/client
```
