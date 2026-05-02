import { describe, expect, test } from "vitest";

import {
  InMemoryCoordinatorStorage,
  SqliteCoordinatorStorage,
} from "../coordinator/index.ts";
import {
  createConfiguredStorage,
  readServerRuntimeConfig,
} from "./runtimeConfig.ts";

describe("readServerRuntimeConfig", () => {
  test("defaults to in-memory storage and server defaults", () => {
    const config = readServerRuntimeConfig({
      CVM_MLS_SERVER_PRIVATE_KEY: "1".repeat(64),
    });

    expect(config.storage).toEqual({ backend: "memory" });
    expect(config.serverInfo.name).toBe("cordn-server");
    expect(config.isAnnouncedServer).toBe(false);
    expect(config.relayUrls).toEqual(["wss://relay.contextvm.org"]);
  });

  test("reads sqlite storage configuration and comma-separated relays", () => {
    const config = readServerRuntimeConfig({
      CVM_MLS_SERVER_PRIVATE_KEY: "2".repeat(64),
      CVM_MLS_STORAGE_BACKEND: "sqlite",
      CVM_MLS_SQLITE_PATH: "./data/cordn.sqlite",
      CVM_MLS_RELAY_URLS: "wss://relay-a.example, wss://relay-b.example",
      CVM_MLS_SERVER_NAME: "custom-cordn",
      CVM_MLS_ANNOUNCED: "1",
    });

    expect(config.storage).toEqual({
      backend: "sqlite",
      sqlitePath: "./data/cordn.sqlite",
    });
    expect(config.relayUrls).toEqual([
      "wss://relay-a.example",
      "wss://relay-b.example",
    ]);
    expect(config.serverInfo.name).toBe("custom-cordn");
    expect(config.isAnnouncedServer).toBe(true);
  });

  test("rejects invalid storage backend values", () => {
    expect(() =>
      readServerRuntimeConfig({
        CVM_MLS_SERVER_PRIVATE_KEY: "3".repeat(64),
        CVM_MLS_STORAGE_BACKEND: "postgres",
      }),
    ).toThrowError("Invalid storage backend");
  });
});

describe("createConfiguredStorage", () => {
  test("creates an in-memory storage by default", () => {
    const storage = createConfiguredStorage({ backend: "memory" });

    expect(storage).toBeInstanceOf(InMemoryCoordinatorStorage);
  });

  test("creates a sqlite-backed storage when configured", () => {
    const storage = createConfiguredStorage({
      backend: "sqlite",
      sqlitePath: ":memory:",
    });

    expect(storage).toBeInstanceOf(SqliteCoordinatorStorage);
    storage.close?.();
  });
});
