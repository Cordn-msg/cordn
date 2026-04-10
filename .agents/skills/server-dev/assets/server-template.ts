#!/usr/bin/env bun
/**
 * ContextVM Server Template
 *
 * A complete starter template for building MCP servers with ContextVM.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  NostrServerTransport,
  PrivateKeySigner,
  ApplesauceRelayPool,
  EncryptionMode,
} from '@contextvm/sdk';
import { z } from 'zod';

// Configuration
const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY!;
const RELAYS = process.env.RELAYS?.split(',') || [
  'wss://relay.contextvm.org',
  'wss://cvm.otherstuff.ai',
];

async function main() {
  // 1. Setup signer and relay handler
  const signer = new PrivateKeySigner(SERVER_PRIVATE_KEY);
  const relayPool = new ApplesauceRelayPool(RELAYS);
  const serverPubkey = await signer.getPublicKey();

  console.log(`Server Public Key: ${serverPubkey}`);
  console.log(`Relays: ${RELAYS.join(', ')}`);

  // 2. Create MCP server
  const server = new McpServer({
    name: 'cvm-starter-server',
    version: '1.0.0',
  });

  // 3. Register tools
  server.registerTool(
    'echo',
    {
      title: 'Echo Tool',
      description: 'Echoes back the provided message',
      inputSchema: {
        message: z.string().describe('Message to echo'),
      },
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: `Echo: ${message}` }],
    })
  );

  // 4. Configure ContextVM transport
  const transport = new NostrServerTransport({
    signer,
    relayHandler: relayPool,
    serverInfo: {
      name: 'ContextVM Starter Server',
      about: 'A starter template for ContextVM servers',
    },
    // Optional: Enable public announcements
    isPublicServer: true,
    // Optional: Require encryption
    encryptionMode: EncryptionMode.OPTIONAL,
    // Optional: Inject client pubkey into _meta
    injectClientPubkey: true,
  });

  // 5. Connect and run
  await server.connect(transport);
  console.log('✓ Server running on Nostr');
  console.log('Press Ctrl+C to stop');

  // Keep running
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
