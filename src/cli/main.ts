import { Command } from "commander";

import { startCliRepl } from "./repl.ts";
import { CliSession } from "./session.ts";

const program = new Command();

program
  .name("cvm-mls-cli")
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
  serverPubkey: options.serverPubkey,
  relays: options.relay.length > 0 ? options.relay : undefined,
});

await startCliRepl(session);
await session.disconnect();
