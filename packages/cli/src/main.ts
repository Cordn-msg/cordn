import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { stdout } from "node:process";

import { startCliRepl } from "./repl.ts";
import { CliSession } from "./session.ts";
import { FileMediaStore } from "./mediaStore.ts";
import { deriveStablePubkey } from "./utils/mlsBase.ts";
import { loadEncryptedState, saveEncryptedState } from "./localState.ts";
import type { CliSessionSnapshot } from "./session.ts";
import { executeReplCommand, tokenizeInput } from "./replCommands.ts";
import { processOutbox } from "./outbox.ts";
import { enqueueInboundMessages } from "./inbox.ts";

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

// Load optional .env then .env.local (first write wins; missing files are
// ignored). Uses Node's native process.loadEnvFile (>= 20.12), which has
// identical semantics to the former @cordn/core env helper.
for (const file of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(file);
  } catch (err) {
    if (
      !(err instanceof Error) ||
      (err as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw err;
    }
  }
}

const program = new Command();

program
  .name("cordn-cli")
  .description("Minimal interactive MLS coordinator CLI")
  .option("--private-key <hex>", "hex private key for the client identity")
  .option("--private-key-file <path>", "file containing the client private key")
  .option("--server-pubkey <hex>", "target ContextVM server public key")
  .option(
    "--relay <url>",
    "relay URL to use",
    (value, current: string[]) => [...current, value],
    [],
  )
  .option(
    "--media-dir <path>",
    "directory for the local content-addressed media store (enables send-media / save-media)",
  )
  .option("--state-file <path>", "encrypted persistent CLI session state")
  .option("--state-key-file <path>", "32-byte state encryption key file")
  .option("--command <line>", "run one command non-interactively and exit")
  .option("--daemon", "run a persistent welcome/sync writer process")
  .option("--group-alias <alias>", "alias used when accepting a Welcome")
  .option(
    "--outbox-dir <path>",
    "process JSON message jobs from this directory while in daemon mode",
  )
  .option(
    "--inbox-dir <path>",
    "write received group messages as atomic JSON jobs while in daemon mode",
  );

program.parse();

const options = program.opts<{
  privateKey?: string;
  privateKeyFile?: string;
  serverPubkey?: string;
  relay: string[];
  mediaDir?: string;
  stateFile?: string;
  stateKeyFile?: string;
  command?: string;
  daemon?: boolean;
  groupAlias?: string;
  outboxDir?: string;
  inboxDir?: string;
}>();

const filePrivateKey = options.privateKeyFile
  ? (await readFile(options.privateKeyFile, "utf8")).trim()
  : undefined;

const stateFile = options.stateFile;
const stateKeyFile =
  options.stateKeyFile ?? (stateFile ? `${stateFile}.key` : undefined);
const snapshot =
  stateFile && stateKeyFile
    ? await loadEncryptedState<CliSessionSnapshot>(stateFile, stateKeyFile)
    : undefined;

const session = new CliSession({
  privateKey: snapshot?.privateKey ?? filePrivateKey ?? options.privateKey,
  serverPubkey: options.serverPubkey ?? readDefaultCoordinatorPubkey(),
  relays: options.relay.length > 0 ? options.relay : readDefaultRelayUrls(),
  mediaStore: options.mediaDir
    ? new FileMediaStore(options.mediaDir)
    : undefined,
});

if (snapshot) await session.restoreSnapshot(snapshot);

const persist = async (): Promise<void> => {
  if (stateFile && stateKeyFile) {
    await saveEncryptedState(stateFile, stateKeyFile, session.exportSnapshot());
  }
};

await persist();
if (options.command) {
  const [command = "", ...args] = tokenizeInput(options.command);
  await executeReplCommand(command, args, { session, output: stdout });
} else if (options.daemon) {
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });

  let inboxWrite = Promise.resolve();
  session.onGroupEvent((event) => {
    if (
      options.inboxDir &&
      event.type === "messages-ingested" &&
      event.received.length > 0
    ) {
      inboxWrite = inboxWrite
        .then(() =>
          enqueueInboundMessages(
            options.inboxDir!,
            event.groupAlias,
            event.received,
          ),
        )
        .then(persist)
        .catch((error) => console.error("inbox/state write failed", error));
    } else {
      inboxWrite = inboxWrite
        .then(persist)
        .catch((error) => console.error("state save failed", error));
    }
  });

  while (!stopping) {
    try {
      const welcomes = await session.fetchWelcomes();
      const heldRefs = new Set(
        session.listKeyPackages().map((entry) => entry.keyPackageRef),
      );
      for (const welcome of welcomes) {
        if (!heldRefs.has(welcome.kp_ref)) continue;
        const alias =
          options.groupAlias ?? `group-${session.listGroups().length + 1}`;
        if (session.listGroups().some((group) => group.alias === alias))
          continue;
        await session.acceptWelcome(welcome.kp_ref, alias);
        await persist();
      }
      await session.watchAllGroups();
      if (options.outboxDir) {
        await processOutbox(options.outboxDir, session, {
          defaultGroupAlias: options.groupAlias,
          persist,
          onSent: (name, cursor) =>
            console.log(`outbox sent ${name} cursor=${cursor}`),
        });
      }
      await persist();
    } catch (error) {
      console.error(
        `daemon cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  await inboxWrite;
} else {
  await startCliRepl(session, persist);
}
await persist();
await session.disconnect();
