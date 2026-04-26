import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NostrServerTransport,
  type NostrServerTransportOptions,
} from "@contextvm/sdk";

import { createCoordinator, Coordinator } from "../coordinator/coordinator.ts";
import {
  CoordinatorAdapter,
  registerCoordinatorMethods,
} from "./coordinatorMethods.ts";

const DEFAULT_RELAY_URLS = ["wss://relay.contextvm.org"];

export function getDefaultRelayUrls(): string[] {
  return [...DEFAULT_RELAY_URLS];
}

export function createServer(coordinator?: Coordinator): {
  coordinator: Coordinator;
  adapter: CoordinatorAdapter;
  server: McpServer;
} {
  const _coordinator = coordinator ?? createCoordinator();
  const adapter = new CoordinatorAdapter(_coordinator);
  const server = new McpServer({
    name: "cordn-server",
    version: "0.1.0",
  });

  registerCoordinatorMethods(server, adapter);

  return { coordinator: _coordinator, adapter, server };
}

export async function connectServer(
  params: NostrServerTransportOptions,
): Promise<
  ReturnType<typeof createServer> & {
    transport: NostrServerTransport;
  }
> {
  const instance = createServer();
  const transport = new NostrServerTransport({
    signer: params.signer,
    relayHandler: params.relayHandler ?? getDefaultRelayUrls(),
    serverInfo: params.serverInfo,
    isAnnouncedServer: params.isAnnouncedServer ?? false,
    injectClientPubkey: true,
    oversizedTransfer: {
      enabled: true,
    },
  });

  await instance.server.connect(transport);

  return { ...instance, transport };
}
