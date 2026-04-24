import { existsSync, readFileSync } from "node:fs";
import { ApplesauceRelayPool, PrivateKeySigner } from "@contextvm/sdk";
import {
  connectContextVmCoordinatorServer,
  getDefaultRelayUrls,
} from "./contextvmCoordinatorServer.ts";

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

function loadRuntimeEnv(): void {
  loadEnvFile(".env");
  loadEnvFile(".env.local");
}

function readOptionalStringEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readOptionalBooleanEnv(name: string): boolean | undefined {
  const value = readOptionalStringEnv(name);
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

function readOptionalSigner(): PrivateKeySigner | undefined {
  const privateKey = readOptionalStringEnv("CVM_MLS_SERVER_PRIVATE_KEY");
  return privateKey ? new PrivateKeySigner(privateKey) : undefined;
}

function readRelayUrls(): string[] {
  const configured = readOptionalStringEnv("CVM_MLS_RELAY_URLS");
  if (!configured) {
    return getDefaultRelayUrls();
  }

  const relayUrls = configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return relayUrls.length > 0 ? relayUrls : getDefaultRelayUrls();
}

async function main(): Promise<void> {
  loadRuntimeEnv();

  const relayUrls = readRelayUrls();
  const serverInfo = {
    name:
      readOptionalStringEnv("CVM_MLS_SERVER_NAME") ??
      "cvm-mls-delivery-service",
    about: readOptionalStringEnv("CVM_MLS_SERVER_ABOUT"),
    website: readOptionalStringEnv("CVM_MLS_SERVER_WEBSITE"),
  };

  await connectContextVmCoordinatorServer({
    signer: readOptionalSigner(),
    relayHandler: new ApplesauceRelayPool(relayUrls),
    serverInfo,
    isAnnouncedServer: readOptionalBooleanEnv("CVM_MLS_ANNOUNCED") ?? false,
  });

  console.log("ContextVM MLS coordinator server connected");
  console.log("relays:", relayUrls.join(", "));
  console.log(
    "announced:",
    serverInfo.name,
    readOptionalBooleanEnv("CVM_MLS_ANNOUNCED") ?? false,
  );
}

main().catch((error: unknown) => {
  console.error("Failed to start ContextVM MLS coordinator server");
  console.error(error);
  process.exit(1);
});
