/**
 * @cordn/sdk — high-level SDK for building cordn applications.
 *
 * Facade layer (CordnClient + managers). See `design/cordn-sdk.md`. Wire-contract
 * types live in `@cordn/core`; this barrel exports the SDK's own domain surface.
 *
 * Subpath exports:
 *   @cordn/sdk/engine   — transport-agnostic group state machine
 *   @cordn/sdk/extra    — optional stores and adapters
 *   @cordn/sdk/testing  — in-process coordinator transport (dev/test only)
 *   @cordn/sdk/mls      — re-exports ts-mls
 */
export * from "./transport.ts";
export * from "./storage.ts";
export * from "./group.ts";
export * from "./client/signer.ts";
export * from "./client/keyPackageManager.ts";
export * from "./client/inviteManager.ts";
export * from "./client/joinRequestManager.ts";
export * from "./client/proposals.ts";
export * from "./client/groupsManager.ts";
export * from "./client/client.ts";
