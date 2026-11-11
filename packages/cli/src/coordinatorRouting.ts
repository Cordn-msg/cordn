/**
 * Re-export shim: the coordinator routing codec (coordinator-handoff.md
 * §4.1) now lives in @cordn/core beside the group metadata codec it trails.
 * Module path kept stable for existing imports.
 */
export {
  decodeCordnCoordinatorRouting,
  encodeCordnCoordinatorRouting,
  type CoordinatorLocator,
  type CordnCoordinatorRouting,
} from "@cordn/core";
