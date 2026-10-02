import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { stdout } from "node:process";
import { dirname, resolve } from "node:path";

import { startCliRepl } from "./repl.ts";
import { CliSession } from "./session.ts";
import { FileMediaStore } from "./mediaStore.ts";
import { deriveStablePubkey } from "./utils/mlsBase.ts";
import {
  openPersistentSession,
  type PersistentSession,
} from "./persistentSession.ts";
import { executeReplCommand, tokenizeInput } from "./replCommands.ts";
import { processOutbox } from "./outbox.ts";
import { enqueueInboundMessages } from "./inbox.ts";
import { welcomeIdentifier } from "./sessionStore.ts";
import { DEFAULT_COORDINATOR_PUBKEY, DEFAULT_RELAY_URLS } from "./defaults.ts";
import { readCliDoc } from "./docs.ts";
import {
  TRANSPORT_ENCRYPTION_MODES,
  type TransportEncryption,
} from "./coordinatorClient.ts";

const { version: cliVersion } = createRequire(import.meta.url)(
  "../package.json",
) as { version: string };

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

function readTransportEncryption(
  flag: string | undefined,
): TransportEncryption | undefined {
  const value = (
    flag ?? readOptionalStringEnv("CORDN_TRANSPORT_ENCRYPTION")
  )?.toLowerCase();
  if (value === undefined) return undefined;
  if (!(TRANSPORT_ENCRYPTION_MODES as readonly string[]).includes(value)) {
    program.error(
      `--transport-encryption/CORDN_TRANSPORT_ENCRYPTION must be one of: ${TRANSPORT_ENCRYPTION_MODES.join(", ")}`,
    );
  }
  return value as TransportEncryption;
}

function readDefaultCoordinatorPubkey(): string | undefined {
  const configured = readOptionalStringEnv("CORDN_SERVER_PRIVATE_KEY");
  if (!configured) {
    return undefined;
  }

  return deriveStablePubkey(configured);
}

const program = new Command();

program
  .name("cordn")
  .description("Persistent MLS coordinator CLI")
  .version(cliVersion)
  .option("--private-key <hex>", "hex private key for the client identity")
  .option("--private-key-file <path>", "file containing the client private key")
  .option(
    "--server-pubkey <hex>",
    `target ContextVM server public key (default: ${DEFAULT_COORDINATOR_PUBKEY})`,
  )
  .option(
    "--relay <url>",
    `relay URL to use; repeatable (defaults: ${DEFAULT_RELAY_URLS.join(", ")})`,
    (value, current?: string[]) => [...(current ?? []), value],
  )
  .option(
    "--transport-encryption <mode>",
    `coordinator request transport: ${TRANSPORT_ENCRYPTION_MODES.join(" | ")}; "required" gift-wraps requests (env CORDN_TRANSPORT_ENCRYPTION; default: disabled)`,
  )
  .option(
    "--media-dir <path>",
    "directory for the local content-addressed media store (enables send-media / save-media)",
  )
  .option("--state-file <path>", "encrypted persistent CLI session state")
  .option(
    "--state-key-file <path>",
    "file containing a hex-encoded 32-byte state encryption key",
  )
  .option("--command <line>", "run one command non-interactively and exit")
  .option("--daemon", "run a persistent welcome/sync writer process")
  .option(
    "--group-alias <alias>",
    "Welcome alias base and default outbox group",
  )
  .option(
    "--outbox-dir <path>",
    "process JSON message jobs from this directory while in daemon mode",
  )
  .option(
    "--inbox-dir <path>",
    "write received group messages as atomic JSON jobs while in daemon mode",
  )
  .addHelpText(
    "after",
    "\nDocumentation:\n  cordn docs [topic]  print bundled quickstart, commands, agent, daemon, queues, or security docs",
  );

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "docs") {
  const topic = ["--help", "-h"].includes(cliArgs[1] ?? "")
    ? undefined
    : cliArgs[1];
  try {
    if (cliArgs.length > 2) throw new Error("usage: cordn docs [topic]");
    const content = await readCliDoc(topic);
    await new Promise<void>((resolve, reject) => {
      stdout.write(
        content.endsWith("\n") ? content : `${content}\n`,
        (error) => (error ? reject(error) : resolve()),
      );
    });
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
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

program.parse();

const options = program.opts<{
  privateKey?: string;
  privateKeyFile?: string;
  serverPubkey?: string;
  relay?: string[];
  transportEncryption?: string;
  mediaDir?: string;
  stateFile?: string;
  stateKeyFile?: string;
  command?: string;
  daemon?: boolean;
  groupAlias?: string;
  outboxDir?: string;
  inboxDir?: string;
}>();

if (options.privateKey && options.privateKeyFile) {
  program.error("--private-key and --private-key-file are mutually exclusive");
}
if (options.command !== undefined && options.daemon) {
  program.error("--command and --daemon are mutually exclusive");
}
if (options.stateKeyFile && !options.stateFile) {
  program.error("--state-key-file requires --state-file");
}
if (
  options.stateFile &&
  options.stateKeyFile &&
  resolve(options.stateFile) === resolve(options.stateKeyFile)
) {
  program.error("--state-file and --state-key-file must be different files");
}
if ((options.inboxDir || options.outboxDir) && !options.daemon) {
  program.error("--inbox-dir/--outbox-dir require --daemon");
}
if (options.daemon && !options.stateFile) {
  program.error("--daemon requires --state-file");
}
if (
  options.inboxDir &&
  options.outboxDir &&
  resolve(options.inboxDir) === resolve(options.outboxDir)
) {
  program.error("--inbox-dir and --outbox-dir must be different directories");
}
if (
  [options.inboxDir, options.outboxDir].some(
    (queueDir) =>
      queueDir &&
      [options.stateFile, options.stateKeyFile].some(
        (path) =>
          (path?.endsWith(".json") || path?.endsWith(".json.processing")) &&
          resolve(queueDir) === dirname(resolve(path)),
      ),
  )
) {
  program.error("state/key .json files cannot be inside queue directories");
}

const transportEncryption = readTransportEncryption(
  options.transportEncryption,
);

const filePrivateKey = options.privateKeyFile
  ? (await readFile(options.privateKeyFile, "utf8")).trim()
  : undefined;
const explicitPrivateKey = filePrivateKey ?? options.privateKey;

let opened: PersistentSession;
try {
  opened = await openPersistentSession({
    stateFile: options.stateFile,
    stateKeyFile: options.stateKeyFile,
    privateKey: explicitPrivateKey,
    serverPubkey: options.serverPubkey,
    relays: options.relay,
    fallback: {
      serverPubkey: readDefaultCoordinatorPubkey(),
      relays: readDefaultRelayUrls(),
    },
    mediaStore: options.mediaDir
      ? new FileMediaStore(options.mediaDir)
      : undefined,
    transportEncryption,
  });
} catch (error) {
  if (
    error instanceof Error &&
    /does not match the identity/.test(error.message)
  ) {
    throw new Error(
      "--private-key/--private-key-file does not match the identity stored in --state-file",
    );
  }
  throw error;
}
const activeSession = opened.session;
const persist = (): Promise<void> => opened.persist();

try {
  await persist();
  if (options.command !== undefined) {
    const [command = "", ...args] = tokenizeInput(options.command);
    try {
      await executeReplCommand(command, args, {
        session: activeSession,
        output: stdout,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else if (options.daemon) {
    let stopping = false;
    process.once("SIGINT", () => {
      stopping = true;
    });
    process.once("SIGTERM", () => {
      stopping = true;
    });

    const stopOnDurabilityFailure = (error: unknown): void => {
      console.error(
        `inbox/state write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      stopping = true;
      process.exitCode = 1;
    };
    activeSession.onGroupEvent((event) => {
      if (event.type !== "messages-ingested") return;
      const writeInbox =
        options.inboxDir && event.received.length > 0
          ? () =>
              enqueueInboundMessages(
                options.inboxDir!,
                event.groupAlias,
                event.received,
              )
          : undefined;
      void opened.persist(writeInbox).catch(stopOnDurabilityFailure);
    });

    while (!stopping) {
      try {
        let welcomes = activeSession.listWelcomes();
        try {
          welcomes = await activeSession.fetchWelcomes();
        } catch (error) {
          console.error(
            `welcome fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const heldRefs = new Set(
          activeSession
            .listKeyPackages()
            .filter((entry) => !entry.consumed || entry.isLastResort)
            .map((entry) => entry.keyPackageRef),
        );
        for (const welcome of welcomes) {
          if (!heldRefs.has(welcome.kp_ref)) continue;
          const alias = uniqueGroupAlias(
            activeSession,
            options.groupAlias ??
              `group-${activeSession.listGroups().length + 1}`,
          );
          try {
            await activeSession.acceptWelcome(
              welcomeIdentifier(welcome),
              alias,
            );
          } catch (error) {
            // One bad Welcome must not stop syncing or the outbox for the rest.
            console.error(
              `accepting welcome ${welcomeIdentifier(welcome)} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            continue;
          }
          await persist();
        }
        await activeSession.watchAllGroups();
        if (options.outboxDir) {
          await processOutbox(options.outboxDir, activeSession, {
            defaultGroupAlias: options.groupAlias,
            persist,
            onSent: (name, cursor) =>
              console.log(`outbox sent ${name} cursor=${cursor}`),
          });
        }
        // Fetch-only Welcome changes are replayable/idempotent; avoid rewriting
        // the full history every five seconds when nothing durable changed.
      } catch (error) {
        console.error(
          `daemon cycle failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (opened.durabilityError) {
          stopping = true;
          process.exitCode = 1;
        }
      }
      if (!stopping) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
    await opened.flush();
  } else {
    if (!options.stateFile) {
      console.error(
        "warning: this session is ephemeral; restart with --state-file <path> to preserve identity and MLS state",
      );
    }
    await startCliRepl(activeSession, persist);
  }
} finally {
  await opened.close();
  if (opened.durabilityError) process.exitCode = 1;
}

function uniqueGroupAlias(session: CliSession, base: string): string {
  const taken = new Set(session.listGroups().map((group) => group.alias));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
