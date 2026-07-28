import type { SerializedEngineState } from "./engine/types.ts";

/**
 * Opaque-blob storage the SDK persists group state to. Bring your own backend
 * (IndexedDB, SQLite, OPFS). `@cordn/sdk/extra` ships an in-memory default.
 * Design #5: one opaque-blob interface, schema versioned from v1.
 */
export interface KeyValueStore<T> {
  getItem(key: string): Promise<T | null>;
  setItem(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * Versioned persisted group state — what `CordnGroup.serialize()` produces and
 * `CordnClient.groups.load(blob)` consumes. Bump `version` and migrate on schema
 * change (openmls CURRENT_VERSION lesson). The engine internals live in
 * `engine`; cursors are group-level.
 */
export interface SerializedGroupBlob {
  version: 1;
  groupId: string;
  engine: SerializedEngineState;
  fetchCursor: number;
  lastCursor: number;
}
