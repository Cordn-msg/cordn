import { existsSync, readFileSync } from "node:fs";

import { PrivateKeySigner } from "@contextvm/sdk";

import {
  createCoordinator,
  InMemoryCoordinatorStorage,
  SqliteCoordinatorStorage,
  type Coordinator,
} from "../coordinator/index.ts";
import { getDefaultRelayUrls } from "./coordinatorServer.ts";

export type StorageBackend = "memory" | "sqlite";

export interface StorageConfig {
  backend: StorageBackend;
  sqlitePath?: string;
}

export interface ServerRuntimeConfig {
  signer: PrivateKeySigner;
  relayUrls: string[];
  serverInfo: {
    name: string;
    about?: string;
    website?: string;
  };
  isAnnouncedServer: boolean;
  storage: StorageConfig;
}

function parseEnvAssignment(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }

  const normalized = trimmed.startsWith("export ")
    ? trimmed.slice(7).trim()
    : trimmed;
  const separatorIndex = normalized.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = normalized.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  let value = normalized.slice(separatorIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    const assignment = parseEnvAssignment(line);
    if (!assignment) {
      continue;
    }

    const [key, value] = assignment;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadRuntimeEnv(): void {
  loadEnvFile(".env");
  loadEnvFile(".env.local");
}

function readOptionalStringEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readOptionalBooleanEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean | undefined {
  const value = readOptionalStringEnv(env, name);
  if (!value) {
    return undefined;
  }

  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  throw new Error(`Invalid boolean environment variable: ${name}`);
}

function readRequiredSigner(env: NodeJS.ProcessEnv): PrivateKeySigner {
  const privateKey = readOptionalStringEnv(env, "CORDN_SERVER_PRIVATE_KEY");
  if (!privateKey) {
    throw new Error(
      "Missing required environment variable: CORDN_SERVER_PRIVATE_KEY",
    );
  }

  return new PrivateKeySigner(privateKey);
}

function readRelayUrls(env: NodeJS.ProcessEnv): string[] {
  const configured = readOptionalStringEnv(env, "CORDN_RELAY_URLS");
  if (!configured) {
    return getDefaultRelayUrls();
  }

  const relayUrls = configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return relayUrls.length > 0 ? relayUrls : getDefaultRelayUrls();
}

function readStorageConfig(env: NodeJS.ProcessEnv): StorageConfig {
  const backendValue =
    readOptionalStringEnv(env, "CORDN_STORAGE_BACKEND") ?? "memory";

  if (backendValue !== "memory" && backendValue !== "sqlite") {
    throw new Error(
      "Invalid storage backend in CORDN_STORAGE_BACKEND: expected 'memory' or 'sqlite'",
    );
  }

  if (backendValue === "memory") {
    return { backend: "memory" };
  }

  return {
    backend: "sqlite",
    sqlitePath:
      readOptionalStringEnv(env, "CORDN_SQLITE_PATH") ?? "./cordn.sqlite",
  };
}

export function readServerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerRuntimeConfig {
  return {
    signer: readRequiredSigner(env),
    relayUrls: readRelayUrls(env),
    serverInfo: {
      name: readOptionalStringEnv(env, "CORDN_SERVER_NAME") ?? "cordn-server",
      about: readOptionalStringEnv(env, "CORDN_SERVER_ABOUT"),
      website: readOptionalStringEnv(env, "CORDN_SERVER_WEBSITE"),
    },
    isAnnouncedServer: readOptionalBooleanEnv(env, "CORDN_ANNOUNCED") ?? false,
    storage: readStorageConfig(env),
  };
}

export function createConfiguredCoordinator(
  config: StorageConfig,
): Coordinator {
  const storage = createConfiguredStorage(config);

  return createCoordinator({ storage });
}

export function createConfiguredStorage(config: StorageConfig) {
  return config.backend === "sqlite"
    ? new SqliteCoordinatorStorage({ path: config.sqlitePath })
    : new InMemoryCoordinatorStorage();
}
