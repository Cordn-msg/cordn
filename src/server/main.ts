import { ApplesauceRelayPool } from "@contextvm/sdk";
import { nip19 } from "nostr-tools";
import pino from "pino";
import { connectServer } from "./coordinatorServer.ts";
import {
  createConfiguredCoordinator,
  loadRuntimeEnv,
  readServerRuntimeConfig,
} from "./runtimeConfig.ts";

const BANNER_RULE = "═".repeat(68);

/** Human-readable startup banner: hex pubkey, nprofile (NIP-19 encoding of
 *  pubkey + relay hints), and a cordn.net URL that auto-adds this
 *  coordinator. Written to stdout rather than pino so the line breaks and
 *  symbols render for operators instead of being JSON-escaped. Structured
 *  `serverPubkey` is still emitted in the later "connected" log line. */
function buildStartupBanner(params: {
  serverPubkey: string;
  relayUrls: string[];
}): string {
  const { serverPubkey, relayUrls } = params;
  const nprofile = nip19.nprofileEncode({
    pubkey: serverPubkey,
    relays: relayUrls,
  });
  const coordinatorUrl = `https://cordn.net/chat/coordinators?c=${nprofile}`;
  const relayLines =
    relayUrls.length > 0
      ? relayUrls.map((relay) => `     • ${relay}`).join("\n")
      : "     (none configured)";
  return [
    "",
    `  ${BANNER_RULE}`,
    "   🔑  CORDN COORDINATOR — Server Public Key",
    `  ${BANNER_RULE}`,
    "",
    `   pubkey    ${serverPubkey}`,
    `   nprofile  ${nprofile}`,
    "",
    "   📡  relays",
    relayLines,
    "",
    "   🌐  add in cordn.net",
    `     ${coordinatorUrl}`,
    "",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  loadRuntimeEnv();
  const runtime = readServerRuntimeConfig();
  const logger = pino({ name: "cordn-server" });
  const serverPubkey = await runtime.signer.getPublicKey();

  process.stdout.write(
    buildStartupBanner({
      serverPubkey,
      relayUrls: runtime.relayUrls,
    }),
  );

  const server = await connectServer({
    coordinator: createConfiguredCoordinator(runtime.storage, runtime.maxAgeMs),
    abuseProtection: runtime.abuseProtection,
    logger,
    signer: runtime.signer,
    relayHandler: new ApplesauceRelayPool(runtime.relayUrls),
    serverInfo: runtime.serverInfo,
    isAnnouncedServer: runtime.isAnnouncedServer,
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "cordn server shutting down");
    server.close();
    process.exit(0);
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  logger.info(
    {
      relays: runtime.relayUrls,
      announced: runtime.isAnnouncedServer,
      serverName: runtime.serverInfo.name,
      storageBackend: runtime.storage.backend,
      sqlitePath: runtime.storage.sqlitePath,
      serverPubkey,
    },
    "ContextVM MLS coordinator server connected",
  );
}

main().catch((error: unknown) => {
  pino({ name: "cordn-server" }).error(
    { error },
    "Failed to start ContextVM MLS coordinator server",
  );
  process.exit(1);
});
