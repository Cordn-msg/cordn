# NostrServerTransport Configuration

## Complete Options Interface

```typescript
interface NostrServerTransportOptions {
  // Required
  signer: NostrSigner;
  relayHandler: RelayHandler | string[];

  // Optional - Server metadata
  serverInfo?: ServerInfo;

  // Optional - Discovery
  /** @deprecated Use isAnnouncedServer instead. */
  isPublicServer?: boolean;
  isAnnouncedServer?: boolean;
  publishRelayList?: boolean;
  relayListUrls?: string[];
  bootstrapRelayUrls?: string[];

  // Optional - Access control
  allowedPublicKeys?: string[];
  isPubkeyAllowed?: (clientPubkey: string) => boolean | Promise<boolean>;
  excludedCapabilities?: CapabilityExclusion[];
  isCapabilityExcluded?: (exclusion: CapabilityExclusion) => boolean | Promise<boolean>;

  // Optional - Features
  injectClientPubkey?: boolean;
  encryptionMode?: EncryptionMode;
  logLevel?: LogLevel;
}
```

## ServerInfo

```typescript
interface ServerInfo {
  name?: string; // Human-readable name
  picture?: string; // Icon URL
  website?: string; // Website URL
  about?: string; // Description
}
```

## CapabilityExclusion

```typescript
interface CapabilityExclusion {
  method: string; // e.g., "tools/call", "tools/list"
  name?: string; // Specific tool/resource name
}
```

## Dynamic Authorization Callbacks

### isPubkeyAllowed

```typescript
isPubkeyAllowed?: (clientPubkey: string) => boolean | Promise<boolean>;
```

Dynamic authorization callback that receives a client public key and returns `true` to allow the connection. Can be async.

When used with `allowedPublicKeys`, both checks must pass (AND logic):

- Client must be in `allowedPublicKeys` (if configured)
- `isPubkeyAllowed` must return `true` (if configured)

Example:

```typescript
isPubkeyAllowed: async (clientPubkey) => {
  const subscription = await db.subscriptions.findByPubkey(clientPubkey);
  return subscription?.isActive ?? false;
};
```

### isCapabilityExcluded

```typescript
isCapabilityExcluded?: (exclusion: CapabilityExclusion) => boolean | Promise<boolean>;
```

Dynamic capability exclusion callback that receives a capability pattern and returns `true` to bypass pubkey authorization. Can be async.

Evaluated after static `excludedCapabilities`. Receives the exclusion being checked as a `CapabilityExclusion` object.

Example:

```typescript
isCapabilityExcluded: async (exclusion) => {
  // Check feature flags for temporarily public capabilities
  if (exclusion.method === 'tools/call') {
    return await featureFlags.isToolPublic(exclusion.name);
  }
  return false;
};
```

## EncryptionMode

- `OPTIONAL` (default) - Use encryption if client supports it
- `REQUIRED` - Only accept encrypted connections
- `DISABLED` - Never use encryption

## Discoverability Options

- `isAnnouncedServer` - Publishes public announcement metadata for relay-based discovery
- `isPublicServer` - Deprecated alias for `isAnnouncedServer`
- `publishRelayList` - TypeScript SDK option that publishes `kind:10002` relay-list metadata unless explicitly disabled
- `relayListUrls` - Explicit relay URLs to advertise in the relay list
- `bootstrapRelayUrls` - Extra relays where discoverability events are published without advertising them as operational relays

## LogLevel

- `debug` - Detailed tracing
- `info` - Lifecycle events
- `warn` - Unexpected situations
- `error` - Failures
- `silent` - No logging

## Structured Tool Results

When building MCP servers on top of [`NostrServerTransport`](../../references/transport-config.md), structured outputs are defined at the tool level rather than on the transport.

- Use `outputSchema` on [`server.registerTool()`](../../SKILL.md) when the tool should expose a validated machine-readable result.
- Return `structuredContent` for programmatic consumers.
- Return `content` for human-readable summaries only.
- `content` and `structuredContent` do not need to contain the same data.
- If a tool is intended only for machine consumption, `content` may be `[]`.

Minimal pattern:

```typescript
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
