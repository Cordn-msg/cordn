/**
 * @cordn/sdk/engine — transport-agnostic cordn group state machine.
 *
 * Owns ClientState, the publish-before-apply lifecycle, structured ingest
 * dispositions (replacing ts-mls error string-matching), per-group operation
 * serialization, and self-echo reconciliation. See `design/cordn-sdk.md`.
 */
export * from "./types.ts";
export * from "./errors.ts";
export { classifyProcessError } from "./classify.ts";
export type { ProcessErrorClass, ClassifiedProcessError } from "./classify.ts";
export {
  findMemberLeafIndexByStablePubkey,
  listGroupMembers,
} from "./members.ts";
export { CordnGroupEngine } from "./engine.ts";
