/**
 * @cordn/sdk/extra — optional stores and adapters.
 *
 * - `InMemoryKeyValueStore` — dev/test key-value store.
 * - `ContextVmTransport` — production transport: a thin client over
 *   `@contextvm/sdk` that encodes the SDK domain types to the `@cordn/core`
 *   base64 wire contract. See `design/cordn-sdk.md`.
 */
export { InMemoryKeyValueStore } from "./inMemoryStore.ts";
export {
  ContextVmTransport,
  decodeKeyPackageFromPublicationEvent,
} from "./contextVm/contextVmTransport.ts";
export type { ContextVmTransportOptions } from "./contextVm/contextVmTransport.ts";
