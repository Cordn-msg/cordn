---
title: Oversized Transfer
description: Bounded oversized payload transfer for ContextVM using MCP progress-notification framing
---

# Oversized Transfer

Oversized transfer is the SDK feature that automatically switches a message to the [CEP-22: Oversized Payload Transfer](/spec/ceps/cep-22) flow when a normal relay event would likely be too large.

In normal use, application code does not send chunks or manage transfer state directly. The transport handles that internally.

## Default Behavior

Oversized transfer is enabled by default on both [`Nostr Client Transport`](/ts-sdk/transports/nostr-client-transport) and [`Nostr Server Transport`](/ts-sdk/transports/nostr-server-transport).

With defaults:

- the SDK automatically detects when a message crosses the oversized threshold
- the SDK fragments and reassembles the payload automatically
- the SDK enforces bounded receiver-side limits for safety
- no extra application logic is required for ordinary usage

This means most consumers do not need to configure anything unless they want stricter limits or different relay-size margins.

## When You Would Change It

Most projects should keep the default behavior.

Tuning is mainly useful when:

- you want to disable the feature completely
- your relay set accepts smaller or larger practical event sizes
- you want stricter memory and concurrency limits on inbound transfers
- you want a different timeout for accept-gated request flows

## Configuration

Use the `oversizedTransfer` transport option to enable, disable, or tune the feature.

```typescript
import { NostrClientTransport } from '@contextvm/sdk';

const transport = new NostrClientTransport({
  signer,
  relayHandler,
  oversizedTransfer: {
    enabled: true,
  },
});
```

Disable it explicitly when you want the transport to avoid CEP-22 fragmentation entirely:

```typescript
import { NostrClientTransport } from '@contextvm/sdk';

const transport = new NostrClientTransport({
  signer,
  relayHandler,
  oversizedTransfer: {
    enabled: false,
  },
});
```

### Options

| Option            | Default                | Meaning                                                                           |
| ----------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `enabled`         | `true`                 | Enables automatic CEP-22 oversized transfer support                               |
| `thresholdBytes`  | `48_000`               | Size at which the sender proactively switches to oversized transfer               |
| `chunkSizeBytes`  | `48_000`               | Maximum payload bytes placed in each emitted chunk                                |
| `acceptTimeoutMs` | `30000` on the client  | How long to wait for `accept` when handshake is required                          |
| `policy`          | built-in safe defaults | Receiver-side limits for bytes, chunks, concurrency, ordering window, and timeout |

## How to Think About the Options

- Use `enabled` when you want a clear on/off switch.
- Use `thresholdBytes` when your relays reject large events earlier than expected, or when you want earlier proactive fragmentation.
- Use `chunkSizeBytes` when you need more headroom for relay-specific event overhead.
- Use `acceptTimeoutMs` when stateless bootstrap flows need a shorter or longer wait window.
- Use `policy` when you need tighter safety bounds for inbound traffic.

## Receiver Policy Defaults

The default receiver policy is intentionally bounded:

- `maxTransferBytes`: `100 MiB`
- `maxTransferChunks`: `10_000`
- `maxConcurrentTransfers`: `64`
- `maxOutOfOrderWindow`: `21`
- `maxOutOfOrderChunks`: `42`
- `transferTimeoutMs`: `5 minutes`

These defaults are appropriate for most consumers. Adjust them only if your deployment has stricter resource constraints or different trust assumptions.

## Errors You May See

If an oversized transfer fails, the transport may surface one of these errors:

| Error                              | Description                                                      |
| ---------------------------------- | ---------------------------------------------------------------- |
| `OversizedTransferAbortError`      | The remote side aborted the transfer                             |
| `OversizedTransferPolicyError`     | The transfer exceeded local safety limits                        |
| `OversizedTransferDigestError`     | Reassembled payload integrity validation failed                  |
| `OversizedTransferReassemblyError` | The transfer completed with missing or inconsistent payload data |
| `OversizedTransferSequenceError`   | The transfer violated CEP-22 frame ordering rules                |

## Recommendations

- Leave oversized transfer enabled unless you have a specific reason not to.
- Keep defaults unless you know your relay environment needs different thresholds.
- Tighten `policy` values if you operate in a more adversarial or resource-constrained environment.
- Refer to [CEP-22: Oversized Payload Transfer](/spec/ceps/cep-22) for protocol-level behavior.

## Related Documentation

- [CEP-22: Oversized Payload Transfer](/spec/ceps/cep-22)
- [Nostr Client Transport](/ts-sdk/transports/nostr-client-transport)
- [Nostr Server Transport](/ts-sdk/transports/nostr-server-transport)
