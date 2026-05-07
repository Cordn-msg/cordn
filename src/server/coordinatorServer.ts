import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NostrServerTransport,
  type NostrServerTransportOptions,
} from "@contextvm/sdk";
import { createCoordinator, Coordinator } from "../coordinator/coordinator.ts";
import {
  CoordinatorAdapter,
  type ResolveRequestEvent,
  registerCoordinatorMethods,
} from "./coordinatorMethods.ts";

const DEFAULT_RELAY_URLS = ["wss://relay.contextvm.org"];

export function getDefaultRelayUrls(): string[] {
  return [...DEFAULT_RELAY_URLS];
}

export function createServer(
  coordinator?: Coordinator,
  resolveRequestEvent?: ResolveRequestEvent,
): {
  coordinator: Coordinator;
  adapter: CoordinatorAdapter;
  server: McpServer;
} {
  const _coordinator = coordinator ?? createCoordinator();
  const adapter = new CoordinatorAdapter(_coordinator, resolveRequestEvent);
  const server = new McpServer({
    name: "cordn-server",
    version: "0.1.0",
  });

  registerCoordinatorMethods(server, adapter);

  return { coordinator: _coordinator, adapter, server };
}

export async function connectServer(
  params: NostrServerTransportOptions & { coordinator?: Coordinator },
): Promise<
  ReturnType<typeof createServer> & {
    transport: NostrServerTransport;
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
  });

  const resolveRequestEvent: ResolveRequestEvent = (requestEventId) => {
    return transport.getNostrRequestEvent(requestEventId) ?? null;
  };
  const instanceWithResolver = createServer(
    params.coordinator,
    resolveRequestEvent,
  );

  await instanceWithResolver.server.connect(transport);

  return { ...instanceWithResolver, transport };
}
