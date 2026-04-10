import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  ApplesauceRelayPool,
  NostrServerTransport,
  type NostrServerTransportOptions,
  PrivateKeySigner,
} from "@contextvm/sdk"
import { generateSecretKey } from "nostr-tools/pure"

import { createDeliveryServiceCoordinator } from "../coordinator/factory.ts"
import { DeliveryServiceCoordinator } from "../coordinator/deliveryServiceCoordinator.ts"
import { ContextVmCoordinatorAdapter, registerCoordinatorContextVmTools } from "./contextvmCoordinatorAdapter.ts"

export interface CreateContextVmCoordinatorServerParams {
  coordinator?: DeliveryServiceCoordinator
}

export interface ConnectContextVmCoordinatorServerParams {
  signer?: PrivateKeySigner
  relayUrls?: string[]
  serverInfo?: NostrServerTransportOptions["serverInfo"]
  isAnnouncedServer?: boolean
}

const DEFAULT_RELAY_URLS = ["wss://relay.contextvm.org"]

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
}

export function createDefaultServerSigner(): PrivateKeySigner {
  return new PrivateKeySigner(bytesToHex(generateSecretKey()))
}

export function getDefaultRelayUrls(): string[] {
  return [...DEFAULT_RELAY_URLS]
}

export function createContextVmCoordinatorServer(params: CreateContextVmCoordinatorServerParams = {}): {
  coordinator: DeliveryServiceCoordinator
  adapter: ContextVmCoordinatorAdapter
  server: McpServer
} {
  const coordinator = params.coordinator ?? createDeliveryServiceCoordinator()
  const adapter = new ContextVmCoordinatorAdapter(coordinator)
  const server = new McpServer({
    name: "cvm-mls-delivery-service",
    version: "0.1.0",
  })

  registerCoordinatorContextVmTools(server, adapter)

  return { coordinator, adapter, server }
}

export async function connectContextVmCoordinatorServer(
  params: ConnectContextVmCoordinatorServerParams,
): Promise<ReturnType<typeof createContextVmCoordinatorServer> & { transport: NostrServerTransport }> {
  const instance = createContextVmCoordinatorServer()
  const relayHandler = new ApplesauceRelayPool(params.relayUrls ?? getDefaultRelayUrls())
  const transport = new NostrServerTransport({
    signer: params.signer ?? createDefaultServerSigner(),
    relayHandler,
    serverInfo: params.serverInfo,
    isAnnouncedServer: params.isAnnouncedServer ?? false,
    injectClientPubkey: true,
    oversizedTransfer: {
      enabled: true,
    },
  })

  await instance.server.connect(transport)

  return { ...instance, transport }
}
