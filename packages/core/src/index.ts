/**
 * @cordn/core — shared foundation for all cordn packages.
 *
 * Wire contracts (zod schemas + inferred types + method names), leaf codecs
 * (base64, MLS framing, last-resort key-package extension), the shared env
 * loader, and the consumed-ref value types. Transport-agnostic and
 * dependency-light (zod, ts-mls): no coordinator state, no Nostr transport.
 */
export * from "./contracts.ts";
export * from "./mlsCodec.ts";
export * from "./lastResortKeyPackage.ts";
export * from "./groupMetadata.ts";
export { decodeBase64, encodeBase64, assertNonEmptyBase64 } from "./base64.ts";
export { loadRuntimeEnv } from "./env.ts";
export type { ConsumedWelcomeRef, ConsumedJoinRequestRef } from "./refs.ts";
