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
      CORDN_SERVER_PRIVATE_KEY: "1".repeat(64),
    });

    expect(config.storage).toEqual({ backend: "memory" });
    expect(config.serverInfo.name).toBe("cordn-server");
    expect(config.isAnnouncedServer).toBe(false);
    expect(config.relayUrls).toEqual(["wss://relay.contextvm.org"]);
  });

  test("reads sqlite storage configuration and comma-separated relays", () => {
    const config = readServerRuntimeConfig({
      CORDN_SERVER_PRIVATE_KEY: "2".repeat(64),
      CORDN_STORAGE_BACKEND: "sqlite",
      CORDN_SQLITE_PATH: "./data/cordn.sqlite",
      CORDN_RELAY_URLS: "wss://relay-a.example, wss://relay-b.example",
      CORDN_SERVER_NAME: "custom-cordn",
      CORDN_ANNOUNCED: "1",
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
        CORDN_SERVER_PRIVATE_KEY: "3".repeat(64),
        CORDN_STORAGE_BACKEND: "postgres",
      }),
    ).toThrow("Invalid storage backend");
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
