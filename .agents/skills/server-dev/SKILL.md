---
name: server-dev
description: Build MCP servers that expose capabilities over the Nostr network using ContextVM. Use when creating new servers, converting existing MCP servers to ContextVM, configuring server transports, implementing access control, or setting up public server announcements.
---

# ContextVM Server Development

Build MCP servers that expose capabilities over Nostr using the `@contextvm/sdk`.

## Quick Start

Create a basic ContextVM server:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NostrServerTransport } from '@contextvm/sdk';
import { PrivateKeySigner } from '@contextvm/sdk';
import { ApplesauceRelayPool } from '@contextvm/sdk';

const signer = new PrivateKeySigner(process.env.SERVER_PRIVATE_KEY!);
const relayPool = new ApplesauceRelayPool(['wss://relay.contextvm.org', 'wss://cvm.otherstuff.ai']);

const server = new McpServer({
  name: 'my-server',
  version: '1.0.0',
});

// Register tools
server.registerTool('echo', { description: 'Echo back the input' }, async ({ message }) => ({
  content: [{ type: 'text', text: `Echo: ${message}` }],
}));

const transport = new NostrServerTransport({
  signer,
  relayHandler: relayPool,
  serverInfo: {
    name: 'My ContextVM Server',
    website: 'https://example.com',
  },
});

await server.connect(transport);
console.log('Server running on Nostr');
```

## NostrServerTransport Options

| Option                 | Type                       | Description                                         |
| ---------------------- | -------------------------- | --------------------------------------------------- |
| `signer`               | `NostrSigner`              | Required. Signs all Nostr events                    |
| `relayHandler`         | `RelayHandler \| string[]` | Required. Relay connection manager.                 |
| `serverInfo`           | `ServerInfo`               | Optional. Metadata for announcements                |
| `isAnnouncedServer`    | `boolean`                  | Publish server announcements. Default: `false`      |
| `publishRelayList`     | `boolean`                  | Publish `kind:10002` relay-list metadata            |
| `relayListUrls`        | `string[]`                 | Explicit relay URLs to advertise                    |
| `bootstrapRelayUrls`   | `string[]`                 | Extra discoverability publication relays            |
| `allowedPublicKeys`    | `string[]`                 | Whitelist client public keys                        |
| `isPubkeyAllowed`      | `function`                 | Dynamic pubkey authorization callback               |
| `excludedCapabilities` | `CapabilityExclusion[]`    | Bypass whitelist for specific methods               |
| `isCapabilityExcluded` | `function`                 | Dynamic capability exclusion callback               |
| `injectClientPubkey`   | `boolean`                  | Inject client pubkey into `_meta`. Default: `false` |
| `encryptionMode`       | `EncryptionMode`           | `OPTIONAL`, `REQUIRED`, or `DISABLED`               |
| `oversizedTransfer`    | `object`                   | CEP-22 oversized payload transfer configuration     |

## Oversized Transfer

`NostrServerTransport` supports CEP-22 oversized payload transfer automatically.

- enabled by default
- automatically reassembles oversized incoming client requests
- automatically fragments oversized server responses when needed
- does not require server tool handlers to manage chunking directly

Typical configuration:

```typescript
const transport = new NostrServerTransport({
  signer,
  relayHandler: relayPool,
  oversizedTransfer: {
    enabled: true,
  },
});
```

Useful reasons to tune it:

- disable the feature entirely with `enabled: false`
- lower `thresholdBytes` or `chunkSizeBytes` for stricter relay environments
- tighten receiver `policy` values to reduce memory exposure

This is especially relevant for servers that return large tool results or accept large structured inputs.

## Access Control

### Public Key Whitelisting

Restrict which clients can connect:

```typescript
const transport = new NostrServerTransport({
  signer,
  relayHandler: relayPool,
  allowedPublicKeys: ['client1-pubkey-hex', 'client2-pubkey-hex'],
});
```

### Capability Exclusions

Allow specific operations from any client:

```typescript
const transport = new NostrServerTransport({
  signer,
  relayHandler: relayPool,
  allowedPublicKeys: ['trusted-client'],
  excludedCapabilities: [
    { method: 'tools/list' }, // Anyone can list tools
    { method: 'tools/call', name: 'public_tool' }, // Specific tool is public
  ],
});
```

### Dynamic Authorization

Use callbacks for runtime authorization decisions:

```typescript
const transport = new NostrServerTransport({
  signer,
  relayHandler: relayPool,
  // Static allowlist (optional)
  allowedPublicKeys: ['admin-pubkey'],
  // Dynamic authorization - both must pass when both are configured
  isPubkeyAllowed: async (clientPubkey) => {
    const subscription = await db.subscriptions.findByPubkey(clientPubkey);
    return subscription?.isActive ?? false;
  },
  // Dynamic capability exclusions
  isCapabilityExcluded: async (exclusion) => {
    // Check feature flags for temporarily public capabilities
    if (exclusion.method === 'tools/call') {
      return await featureFlags.isToolPublic(exclusion.name);
    }
    return false;
  },
});
```

## Public Server Announcements

Enable discovery by publishing replaceable events:

```typescript
const transport = new NostrServerTransport({
  signer,
  relayHandler: relayPool,
  isAnnouncedServer: true,
  publishRelayList: true,
  bootstrapRelayUrls: ['wss://relay.damus.io', 'wss://nos.lol'],
  serverInfo: {
    name: 'Weather Service',
    about: 'Get weather data worldwide',
    website: 'https://weather.example.com',
  },
});
```

Publishes events on kinds 11316-11320 with your server's capabilities. In the TypeScript SDK, `publishRelayList` is independent from `isAnnouncedServer` and defaults to enabled, so relay-list metadata is published unless you explicitly opt out.

### Relay-list publication strategy

- CEP-17 is protocol-level and implementation-agnostic; the defaults below describe the TypeScript SDK behavior, not a protocol requirement
- Use `relayHandler` for the relays where your server actually operates
- Use `relayListUrls` only if you need to override the advertised relay list
- Use `bootstrapRelayUrls` when you want broader discoverability publication without advertising those relays as operational endpoints
- Set `publishRelayList: false` only if you intentionally want to disable CEP-17 relay-list publication

## Client Public Key Injection

Access the client's identity in your tools:

```typescript
const transport = new NostrServerTransport({
  signer,
  relayHandler: relayPool,
  injectClientPubkey: true,
});

// In your tool handler, access _meta.clientPubkey
server.registerTool("personalized", {...}, async (args, extra) => {
  const clientPubkey = extra._meta?.clientPubkey;
  // Use pubkey for personalization, rate limiting, etc.
});
```

## Structured Outputs

Use structured outputs when your server is primarily consumed programmatically and clients benefit from validated machine-readable tool results.

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

const server = new McpServer({
  name: 'weather-server',
  version: '1.0.0',
});

server.registerTool(
  'get_weather',
  {
    description: 'Get weather information for a city',
    inputSchema: z.object({ city: z.string(), country: z.string() }),
    outputSchema: z.object({
      temperature: z.object({ celsius: z.number(), fahrenheit: z.number() }),
      conditions: z.string(),
    }),
  },
  async () => ({
    content: [],
    structuredContent: {
      temperature: { celsius: 22, fahrenheit: 71.6 },
      conditions: 'sunny',
    },
  })
);
```

- Use `outputSchema` when clients should be able to rely on a stable output shape.
- Return `structuredContent` for machine-readable data.
- Return `content` only for human-readable output. It does not need to duplicate `structuredContent`.
- If human-readable output is unnecessary, `content` can be an empty array: `[]`.
- A good pattern is: concise `content` for people, complete `structuredContent` for code.

## Server Templates

See [`assets/server-template.ts`](assets/server-template.ts) for a complete starting point.

## Debugging (MCP Inspector)

Use the MCP Inspector to validate your MCP server behavior (tools/resources/prompts schemas, request/response shape) before exposing it via ContextVM.

From the MCP docs, the Inspector is typically run via `npx`:

```bash
npx @modelcontextprotocol/inspector <command>
```

Practical workflow for ContextVM:

1. Implement and test your server logic using a standard MCP transport (commonly STDIO) so it can be inspected.
2. Use the Inspector to iterate on tool schemas and error handling.
3. Once stable, swap the transport to `NostrServerTransport`.

If you need details on Inspector usage and common debugging steps, read:

- [`references/debugging-inspector.md`](references/debugging-inspector.md)

## Reference Materials

- [`references/transport-config.md`](references/transport-config.md) - All configuration options
- [`references/security-patterns.md`](references/security-patterns.md) - Access control patterns
- [`references/gateway-pattern.md`](references/gateway-pattern.md) - Exposing existing servers
- MCP structured output guide: define `outputSchema`, return `structuredContent`, and keep `content` human-oriented
