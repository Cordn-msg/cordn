import { McpServer } from "@contextvm/mcp-sdk/server/mcp";
import {
  NostrServerTransport,
  type NostrServerTransportOptions,
} from "@contextvm/sdk";
import { createCoordinator, Coordinator } from "@cordn/coordinator";
import {
  CoordinatorAdapter,
  type AbuseProtectionOptions,
  type ResolveRequestEvent,
  registerCoordinatorMethods,
} from "./coordinatorMethods.ts";
import { consoleServerLogger, type ServerLogger } from "./logger.ts";

const DEFAULT_RELAY_URLS = ["wss://relay.contextvm.org"];

export function getDefaultRelayUrls(): string[] {
  return [...DEFAULT_RELAY_URLS];
}

/**
 * CEP-41 open-stream keepalive window for server-delivered streams.
 *
 * A writer is flushed once the client stays quiet for `idleTimeoutMs` AND
 * then fails to `pong` the liveness probe within `probeTimeoutMs`. The SDK
 * defaults (30s + 20s = 50s) are too short for cordn's long-lived
 * subscription streams, which can sit idle between group messages. Bumped to
 * a 120s total, split evenly: the probe gets the full half so a slow client
 * has ample room to pong.
 */
const OPEN_STREAM_IDLE_TIMEOUT_MS = 60_000;
const OPEN_STREAM_PROBE_TIMEOUT_MS = 60_000;

export function createServer(
  coordinator?: Coordinator,
  resolveRequestEvent?: ResolveRequestEvent,
  abuseProtection?: AbuseProtectionOptions,
  logger: ServerLogger = consoleServerLogger,
): {
  coordinator: Coordinator;
  adapter: CoordinatorAdapter;
  server: McpServer;
} {
  const _coordinator = coordinator ?? createCoordinator();
  const adapter = new CoordinatorAdapter(
    _coordinator,
    resolveRequestEvent,
    abuseProtection,
    logger,
  );
  const server = new McpServer({
    name: "cordn-server",
    version: "0.1.0",
  });

  registerCoordinatorMethods(server, adapter);

  return { coordinator: _coordinator, adapter, server };
}

export async function connectServer(
  params: NostrServerTransportOptions & {
    coordinator?: Coordinator;
    abuseProtection?: AbuseProtectionOptions;
    logger?: ServerLogger;
  },
): Promise<
  ReturnType<typeof createServer> & {
    transport: NostrServerTransport;
    close: () => void;
  }
> {
  const transport = new NostrServerTransport({
    signer: params.signer,
    relayHandler: params.relayHandler ?? getDefaultRelayUrls(),
    serverInfo: params.serverInfo,
    isAnnouncedServer: params.isAnnouncedServer ?? false,
    injectClientPubkey: true,
    injectRequestEventId: true,
    oversizedTransfer: {
      enabled: true,
    },
    openStream: {
      enabled: true,
      policy: {
        idleTimeoutMs: OPEN_STREAM_IDLE_TIMEOUT_MS,
        probeTimeoutMs: OPEN_STREAM_PROBE_TIMEOUT_MS,
      },
    },
  });

  const resolveRequestEvent: ResolveRequestEvent = (requestEventId) => {
    return transport.getNostrRequestEvent(requestEventId) ?? null;
  };
  const instanceWithResolver = createServer(
    params.coordinator,
    resolveRequestEvent,
    params.abuseProtection,
    params.logger ?? consoleServerLogger,
  );

  await instanceWithResolver.server.connect(transport);

  return {
    ...instanceWithResolver,
    transport,
    close: () => {
      instanceWithResolver.adapter.close();
    },
  };
}
