---
name: typescript-sdk
description: Use the @contextvm/sdk TypeScript SDK effectively. Reference for core interfaces, signers, relay handlers, transports, encryption, logging, and SDK patterns. Use when implementing SDK components, extending interfaces, configuring transports, or debugging SDK usage.
---

# ContextVM TypeScript SDK

Reference guide for using `@contextvm/sdk` effectively.

## Installation

```bash
npm install @contextvm/sdk
# or
bun add @contextvm/sdk
```

## Core Imports

```typescript
// Transports
import { NostrClientTransport, NostrServerTransport } from '@contextvm/sdk';

// Signers
import { PrivateKeySigner } from '@contextvm/sdk';

// Relay Handlers
import { ApplesauceRelayPool } from '@contextvm/sdk';

// Components
import { NostrMCPProxy, NostrMCPGateway } from '@contextvm/sdk';

// Core types and utilities
import {
  EncryptionMode,
  CTXVM_MESSAGES_KIND,
  SERVER_ANNOUNCEMENT_KIND,
  createLogger,
} from '@contextvm/sdk';
```

## Core Interfaces

### NostrSigner

Abstracts cryptographic signing:

```typescript
interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}
```

Implement for custom key management (hardware wallets, browser extensions, etc.).

### RelayHandler

Manages relay connections:

```typescript
interface RelayHandler {
  connect(): Promise<void>;
  disconnect(relayUrls?: string[]): Promise<void>;
  publish(event: NostrEvent): Promise<void>;
  subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void
  ): Promise<void>;
  unsubscribe(): void;
}
```

**Must be non-blocking** - `subscribe()` returns immediately.

## Signers

### PrivateKeySigner

Default signer using raw private key:

```typescript
const signer = new PrivateKeySigner('32-byte-hex-private-key');
const pubkey = await signer.getPublicKey();
```

**Security**: Never hardcode keys. Use environment variables.

### Custom Signers

Implement `NostrSigner` for:

- Browser extensions (NIP-07)
- Hardware wallets
- Remote signing services
- Secure enclaves

See [`references/custom-signers.md`](references/custom-signers.md) for examples.

## Relay Handlers

### ApplesauceRelayPool (Recommended)

Production-grade relay management:

```typescript
const pool = new ApplesauceRelayPool(['wss://relay.contextvm.org', 'wss://cvm.otherstuff.ai']);
```

Features:

- Automatic reconnection
- Connection monitoring
- RxJS-based observables
- Persistent subscriptions

Use `ApplesauceRelayPool` for projects.

For [`NostrClientTransport`](cvmi/skills/typescript-sdk/SKILL.md:22), `relayHandler` can be omitted when the client should resolve operational relays dynamically. The resolution order is:

1. explicit operational relays from `relayHandler`
2. relay hints embedded in `nprofile`
3. CEP-17 relay-list discovery via `discoveryRelayUrls`
4. `fallbackOperationalRelayUrls`
5. SDK bootstrap discovery relays when `discoveryRelayUrls` is omitted

This makes client configuration simpler when the server already publishes `kind:10002` metadata.

Use [`fallbackOperationalRelayUrls`](cvmi/skills/typescript-sdk/SKILL.md) when you want non-authoritative operational relays to be probed in parallel with CEP-17 discovery. This is useful for low-latency local relays or known-good operational relays that should only be used when explicit relays and `nprofile` hints are absent.

Important semantics:

- [`relayHandler`](cvmi/skills/typescript-sdk/SKILL.md:124) remains the explicit authoritative operational relay set.
- [`discoveryRelayUrls`](cvmi/skills/typescript-sdk/SKILL.md) remains discovery-only.
- [`fallbackOperationalRelayUrls`](cvmi/skills/typescript-sdk/SKILL.md) is non-authoritative and should not replace published `kind:10002` metadata when that metadata resolves in time.

## Encryption Modes

```typescript
enum EncryptionMode {
  OPTIONAL = 'optional', // Use if supported (default)
  REQUIRED = 'required', // Fail if not supported
  DISABLED = 'disabled', // Never encrypt
}
```

## Oversized Transfer

The SDK supports CEP-22 oversized payload transfer on both client and server transports.

Important consumer-facing behavior:

- oversized transfer is enabled by default
- transports automatically fragment and reassemble large payloads
- most applications do not need to manage chunking directly
- the main decision is whether to keep it enabled or disable it explicitly

Typical configuration:

```typescript
const clientTransport = new NostrClientTransport({
  signer,
  serverPubkey,
  oversizedTransfer: {
    enabled: true,
  },
});
```

Relevant options:

- `enabled`: explicit on/off switch for CEP-22 behavior
- `thresholdBytes`: proactive fragmentation threshold
- `chunkSizeBytes`: per-chunk size
- `acceptTimeoutMs`: client-side wait time for accept-gated flows
- `policy`: receiver-side limits for bytes, chunks, concurrency, ordering window, and timeout

Use lower thresholds or chunk sizes when relays are more restrictive. Tighten policy values when operating in resource-constrained or adversarial environments.

## Logging

```typescript
import { createLogger } from '@contextvm/sdk/core';

const logger = createLogger('my-module');

logger.info('event.name', {
  module: 'my-module',
  txId: 'abc-123',
  durationMs: 245,
});
```

Configure via environment:

- `LOG_LEVEL=debug|info|warn|error`
- `LOG_DESTINATION=stderr|stdout|file`
- `LOG_FILE=/path/to/file`
- `LOG_ENABLED=true|false`

## Constants

| Constant                   | Value | Description            |
| -------------------------- | ----- | ---------------------- |
| `CTXVM_MESSAGES_KIND`      | 25910 | Ephemeral messages     |
| `SERVER_ANNOUNCEMENT_KIND` | 11316 | Server metadata        |
| `RELAY_LIST_METADATA_KIND` | 10002 | Relay-list metadata    |
| `TOOLS_LIST_KIND`          | 11317 | Tools announcement     |
| `RESOURCES_LIST_KIND`      | 11318 | Resources announcement |
| `GIFT_WRAP_KIND`           | 1059  | Encrypted messages     |

## SDK Patterns

See [`references/patterns.md`](references/patterns.md) for:

- Error handling
- Retry strategies
- Connection lifecycle
- Resource cleanup

## API Reference

- [`references/interfaces.md`](references/interfaces.md) - Complete interface definitions
- [`references/constants.md`](references/constants.md) - All exported constants
- [`references/logging.md`](references/logging.md) - Logging best practices
