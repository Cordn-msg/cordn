# Gateway Pattern

Use `NostrMCPGateway` to expose an existing MCP server to Nostr without modifying it.

## When to Use

- You have an existing MCP server that uses stdio transport
- You want to add Nostr accessibility without changing server code
- You need to decouple the core server from public network access

## Architecture

```
Nostr Client <---> NostrMCPGateway <---> Existing MCP Server
                     (Gateway)            (Stdio)
```

## Example

```typescript
import { NostrMCPGateway } from '@contextvm/sdk';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const gateway = new NostrMCPGateway({
  // Connect to existing server via stdio
  mcpClientTransport: new StdioClientTransport({
    command: 'bun',
    args: ['run', './existing-server.ts'],
  }),

  // Expose on Nostr
  nostrTransportOptions: {
    signer: new PrivateKeySigner(gatewayKey),
    relayHandler: new ApplesauceRelayPool(relays),
    isAnnouncedServer: true,
    allowedPublicKeys: [trustedClient],
  },
});

await gateway.start();
```

## Security Benefits

- Core server runs in isolated environment
- Gateway handles all Nostr-specific concerns
- Add access control at gateway layer
- Easy to swap or upgrade either component
