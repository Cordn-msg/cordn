import { Command } from "commander";

import { loadRuntimeEnv } from "../server/runtimeConfig.ts";
import { startCliRepl } from "./repl.ts";
import { CliSession } from "./session.ts";
import { deriveStablePubkey } from "./utils/mlsBase.ts";

function readOptionalStringEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readDefaultRelayUrls(): string[] | undefined {
  const configured = readOptionalStringEnv("CORDN_RELAY_URLS");
  if (!configured) {
    return undefined;
  }

  const relayUrls = configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return relayUrls.length > 0 ? relayUrls : undefined;
}

function readDefaultCoordinatorPubkey(): string | undefined {
  const configured = readOptionalStringEnv("CORDN_SERVER_PRIVATE_KEY");
  if (!configured) {
    return undefined;
  }

  return deriveStablePubkey(configured);
}

loadRuntimeEnv();

const program = new Command();

program
  .name("cordn-cli")
  .description("Minimal interactive MLS coordinator CLI")
  .option("--private-key <hex>", "hex private key for the client identity")
  .option("--server-pubkey <hex>", "target ContextVM server public key")
  .option(
    "--relay <url>",
    "relay URL to use",
    (value, current: string[]) => [...current, value],
    [],
  );

program.parse();

const options = program.opts<{
  privateKey?: string;
  serverPubkey?: string;
  relay: string[];
}>();

const session = new CliSession({
  privateKey: options.privateKey,
  serverPubkey: options.serverPubkey ?? readDefaultCoordinatorPubkey(),
  relays: options.relay.length > 0 ? options.relay : readDefaultRelayUrls(),
});

await startCliRepl(session);
await session.disconnect();
