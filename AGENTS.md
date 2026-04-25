# AGENTS.md

## Project overview

[`cordn`](package.json) is a TypeScript MLS delivery service and ContextVM server adapter. It provides:

- a ContextVM/MCP server wrapper around that coordinator
- a small CLI client for local and integration testing

Primary implementation areas:

- [`src/coordinator/`](src/coordinator/) — core delivery-service state and behavior
- [`src/server/`](src/server/) — ContextVM server bindings and runnable server entrypoint
- [`src/cli/`](src/cli/) — terminal client and integration helpers
- [`src/contracts/`](src/contracts/) — shared request/response contracts

## Setup commands

- Install dependencies: `pnpm install`
- Start the server: `pnpm run dev`
- Start the CLI client: `pnpm run client:cli`
- Type-check: `pnpm run typecheck`
- Build the server bundle: `pnpm run build`
- Run all tests: `pnpm run test`
- Format source files: `pnpm run format`

## Development workflow

- Package manager: `pnpm`
- Runtime: Node.js in local scripts
- Main server entrypoint: [`src/server/main.ts`](src/server/main.ts)
- Public exports: [`src/index.ts`](src/index.ts)
- Build output: `dist/`

Environment notes for the server:

- Optional `.env` and `.env.local` files are loaded by [`loadRuntimeEnv()`](src/server/main.ts:54)
- Relevant variables include `CVM_MLS_SERVER_PRIVATE_KEY`, `CVM_MLS_RELAY_URLS`, `CVM_MLS_SERVER_NAME`, `CVM_MLS_SERVER_ABOUT`, `CVM_MLS_SERVER_WEBSITE`, and `CVM_MLS_ANNOUNCED`

## Testing instructions

- Test runner: Vitest configured in [`vitest.config.ts`](vitest.config.ts)
- Run full suite: `pnpm run test`
- Run a single test file: `pnpm exec vitest run src/coordinator/coordinator.test.ts`
- Run matching tests by name: `pnpm exec vitest run -t "key package"`

Test locations:

- unit/integration tests live beside source files under [`src/`](src/)
- file naming follows `*.test.ts` and `*.integration.test.ts`

Agent expectations:

- add or update tests when changing coordinator, server, CLI, or contract behavior
- run targeted Vitest commands for touched areas before finishing
- run `pnpm run typecheck` when changing public types, contracts, or entrypoints

## Code style

- Language: TypeScript with ESM-style imports
- Prefer small, direct modules over abstraction-heavy refactors
- Keep naming aligned with domain concepts already used in [`src/coordinator/types.ts`](src/coordinator/types.ts)
- Use existing relative import style with explicit `.ts` extensions
- Format changes with `pnpm run format` when editing source files

## Build and deployment

- Production build uses [`pnpm run build`](package.json:8) and bundles [`src/server/main.ts`](src/server/main.ts) with esbuild
- Output is written to `dist/`
- There is no separate deployment automation in this repository; deployment is currently a manual server-start flow

## PR and change guidance

- Keep changes scoped and minimal
- Preserve current script names and repository layout unless the task explicitly requires otherwise
- If you change external behavior, update tests and any affected CLI/help text

## Troubleshooting notes

- If the server fails at startup, verify relay URLs and `CVM_MLS_SERVER_PRIVATE_KEY`
- If tests hang or become flaky, check integration-style tests under [`src/cli/`](src/cli/) and [`src/server/`](src/server/)
- If imports fail at runtime, confirm explicit `.ts` extensions are preserved in source imports
