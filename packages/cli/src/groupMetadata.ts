/**
 * Re-export shim: the group metadata extension codec (spec/01.md §4) and its
 * shared helpers now live in @cordn/core so the CLI and the web client read
 * one definition. Module path kept stable for existing imports.
 */
export {
  CORDN_GROUP_METADATA_EXTENSION_TYPE,
  createCordnMetadataCapabilities,
  decodeCordnGroupMetadata,
  encodeCordnGroupMetadata,
  getCordnGroupMetadataExtension,
  makeCordnGroupMetadataExtension,
  metadataWithVoidedRouting,
  normalizePubkey,
  type CordnGroupMetadata,
} from "@cordn/core";
