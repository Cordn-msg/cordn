/**
 * @cordn/sdk/testing — dev/test-only helpers.
 *
 * Ships the in-process coordinator transport (backed by `@cordn/coordinator`)
 * so the SDK and its consumers can run end-to-end with zero Nostr / network.
 * `@cordn/coordinator` is a devDependency; this subpath must not be used in
 * production app paths. See `design/cordn-sdk.md` (decision #10).
 */
export { createInProcessTransport } from "./inProcessTransport.ts";
export type { InProcessTransportOptions } from "./inProcessTransport.ts";
export {
  createPrivateKeySigner,
  PrivateKeySigner,
} from "./privateKeySigner.ts";
