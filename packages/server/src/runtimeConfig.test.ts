import { describe, expect, test } from "vitest";

import {
  InMemoryCoordinatorStorage,
  SqliteCoordinatorStorage,
} from "@cordn/coordinator";
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
    expect(config.abuseProtection).toEqual({
      rateLimit: {
        enabled: true,
        refillPerMinute: 500,
        burst: 160,
        idleTtlMs: 3_600_000,
      },
      keyPackageQuota: {
        maxPerIdentity: 50,
        maxLastResortPerIdentity: 1,
      },
      logRejections: true,
    });
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

  test("reads abuse protection configuration", () => {
    const config = readServerRuntimeConfig({
      CORDN_SERVER_PRIVATE_KEY: "4".repeat(64),
      CORDN_RATE_LIMIT_ENABLED: "false",
      CORDN_RATE_LIMIT_REFILL_PER_MINUTE: "400",
      CORDN_RATE_LIMIT_BURST: "120",
      CORDN_RATE_LIMIT_IDLE_TTL_SECONDS: "10",
      CORDN_MAX_KEY_PACKAGES_PER_IDENTITY: "75",
      CORDN_MAX_LAST_RESORT_KEY_PACKAGES_PER_IDENTITY: "2",
      CORDN_LOG_ABUSE_REJECTIONS: "0",
    });

    expect(config.abuseProtection).toEqual({
      rateLimit: {
        enabled: false,
        refillPerMinute: 400,
        burst: 120,
        idleTtlMs: 10_000,
      },
      keyPackageQuota: {
        maxPerIdentity: 75,
        maxLastResortPerIdentity: 2,
      },
      logRejections: false,
    });
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
