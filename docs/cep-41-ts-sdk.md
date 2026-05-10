---
title: Open Stream
description: CEP-41 open-ended stream support in the ContextVM TypeScript SDK
---

# Open Stream

Open stream is the SDK support for [CEP-41: Open-Ended Stream Transfer](/spec/ceps/cep-41). It is designed for MCP exchanges that produce useful output incrementally, such as long-running tool execution, progressive generation, and event-like result delivery.

In the SDK, CEP-41 support is exposed as a small set of transport-layer primitives plus a convenience helper for tool calls, all documented on this page.

## What the SDK Provides

The transport exports the following CEP-41 building blocks:

- [`OpenStreamWriter`](src/transport/open-stream/writer.ts) for producing outbound stream frames
- [`OpenStreamSession`](src/transport/open-stream/session.ts) for consuming inbound stream chunks as an async iterable
- [`OpenStreamReceiver`](src/transport/open-stream/receiver.ts) for routing inbound progress notifications into tracked sessions
- [`OpenStreamRegistry`](src/transport/open-stream/registry.ts) for managing multiple active sessions by `progressToken`
- [`callToolStream()`](src/transport/call-tool-stream.ts:28) for client-side MCP tool calls that return both the final tool result and the paired open stream handle

These APIs are exported from [`src/transport/index.ts`](src/transport/index.ts) and re-exported from [`src/index.ts`](src/index.ts), so consumers can import them directly from `@contextvm/sdk`.

## When to Use It

Use open streams when the data itself is incremental and should be processed as it arrives.

Typical cases include:

- token-by-token or fragment-by-fragment generation
- large logical outputs where progressive consumption is more useful than waiting for the final response
- feeds or server-side event sequences associated with a request
- long-running tool calls where users benefit from intermediate output before the final MCP response arrives

If you only need to move one bounded oversized payload, prefer [Oversized Transfer](/ts-sdk/transports/oversized-transfer), which implements CEP-22 bounded chunking and reassembly.

## Mental Model

CEP-41 does **not** replace the final JSON-RPC response.

Instead, one logical MCP request can have two related outputs:

1. an open stream carried by `notifications/progress`
2. the final JSON-RPC success or error response for the original request

The SDK mirrors that model closely:

- [`OpenStreamSession`](src/transport/open-stream/session.ts) yields ordered stream chunks as they become available
- the original MCP call still resolves separately with the final tool result or error

## Client-Side Convenience: `callToolStream()`

For most client usage, the highest-level entry point is [`callToolStream()`](src/transport/call-tool-stream.ts:28).

It creates a `progressToken`, registers an outbound session on the client transport, sends the MCP `tools/call` request with that token, and returns:

- `progressToken`
- `stream`: the associated [`OpenStreamSession`](src/transport/open-stream/session.ts)
- `result`: a promise for the final MCP tool response
- `abort()`: a convenience method that aborts the local stream session

### Client example

```typescript
import {
  callToolStream,
  NostrClientTransport,
  PrivateKeySigner,
} from '@contextvm/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const transport = new NostrClientTransport({
  signer: new PrivateKeySigner('your-private-key'),
  serverPubkey: 'npub1...',
  relayHandler: ['wss://relay.example.com'],
});

const client = new Client({
  name: 'streaming-client',
  version: '1.0.0',
});

await client.connect(transport);

const call = await callToolStream({
  client,
  transport,
  name: 'streaming_tool',
  arguments: {
    prompt: 'Explain CEP-41 in short steps',
  },
});

for await (const chunk of call.stream) {
  console.log(chunk.chunkIndex, chunk.value);
}

const result = await call.result;
console.log(result);
```

This is the clearest way to consume streaming tool output when you want both progressive fragments and the final MCP tool result.

If your application already has its own request correlation or tracing scheme, you can also pass an explicit `progressToken` to [`callToolStream()`](src/transport/call-tool-stream.ts:28) instead of letting the helper generate one internally.

### What `callToolStream()` returns

[`callToolStream()`](src/transport/call-tool-stream.ts:28) accepts [`CallToolStreamParams`](src/transport/call-tool-stream.ts:6) and resolves to [`ToolStreamCall`](src/transport/call-tool-stream.ts:14).

| Property | Meaning |
| --- | --- |
| `progressToken` | The token used for both the MCP request and the stream correlation |
| `stream` | The paired [`OpenStreamSession`](src/transport/open-stream/session.ts) |
| `result` | Promise for the final MCP tool call result |
| `abort()` | Aborts the local stream session |

This is why the helper is usually preferable to assembling the request metadata and session correlation manually.

## Enabling Open Stream on Transports

To use CEP-41 across the Nostr transports, enable `openStream` on both the server and the client transport.

This is the shape exercised by the end-to-end tests in [`src/transport/call-tool-stream.e2e.test.ts`](src/transport/call-tool-stream.e2e.test.ts):

```typescript
const serverTransport = new NostrServerTransport({
  signer: new PrivateKeySigner(serverPrivateKey),
  relayHandler: relayHandler,
  openStream: {
    enabled: true,
  },
});

const clientTransport = new NostrClientTransport({
  signer: new PrivateKeySigner(clientPrivateKey),
  relayHandler: relayHandler,
  serverPubkey: serverPublicKey,
  openStream: {
    enabled: true,
  },
});
```

You can also provide policy overrides through [`OpenStreamTransportPolicy`](src/transport/open-stream-policy.ts:4).

## Reading Stream Chunks

[`OpenStreamSession`](src/transport/open-stream/session.ts) implements `AsyncIterable`, so you can iterate over stream fragments using `for await`.

Each yielded item has the shape defined by [`OpenStreamReadResult`](src/transport/open-stream/types.ts:67):

- `value`: the chunk payload
- `chunkIndex`: the contiguous chunk index

Example:

```typescript
for await (const chunk of stream) {
  process.stdout.write(chunk.value);
}
```

The session also exposes [`closed`](src/transport/open-stream/session.ts:57) and [`abort()`](src/transport/open-stream/session.ts:109), which are useful when coordinating lifecycle, cancellation, and cleanup.

## Writer API for Producers

On the producing side, [`OpenStreamWriter`](src/transport/open-stream/writer.ts) emits correctly ordered CEP-41 frames:

- [`start()`](src/transport/open-stream/writer.ts:51)
- [`write()`](src/transport/open-stream/writer.ts:66)
- [`ping()`](src/transport/open-stream/writer.ts:83)
- [`pong()`](src/transport/open-stream/writer.ts:98)
- [`close()`](src/transport/open-stream/writer.ts:112)
- [`abort()`](src/transport/open-stream/writer.ts:129)

The writer automatically:

- increments MCP `progress`
- assigns contiguous `chunkIndex` values
- includes `lastChunkIndex` on `close` when chunks were emitted
- preserves CEP-41 start/chunk/close ordering for normal writes

### Full minimal producer example

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  NostrServerTransport,
  type OpenStreamWriter,
  PrivateKeySigner,
} from '@contextvm/sdk';

function getOpenStreamWriter(extra: {
  _meta?: Record&lt;string, unknown&gt;;
}): OpenStreamWriter {
  const stream = (extra._meta as { stream?: OpenStreamWriter } | undefined)
    ?.stream;

  if (!stream) {
    throw new Error('Expected open stream writer in _meta.stream');
  }

  return stream;
}

const server = new McpServer({
  name: 'streaming-server',
  version: '1.0.0',
});

const transport = new NostrServerTransport({
  signer: new PrivateKeySigner('your-private-key'),
  relayHandler: ['wss://relay.example.com'],
  openStream: {
    enabled: true,
  },
  serverInfo: {
    name: 'streaming-server',
  },
});

server.registerTool(
  'streaming_tool',
  {
    title: 'Streaming tool',
    description: 'Emits incremental text before the final tool result',
    inputSchema: {
      prompt: z.string(),
    },
  },
  async ({ prompt }, extra) =&gt; {
    const stream = getOpenStreamWriter(extra);

    await stream.start();
    await stream.write(`Starting: ${prompt}\n`);
    await stream.write('Step 1 complete\n');
    await stream.write('Step 2 complete\n');
    await stream.close();

    return {
      content: [
        {
          type: 'text',
          text: `Finished processing: ${prompt}`,
        },
      ],
    };
  },
);

await server.connect(transport);
```

This example shows the full producer-side shape:

- an MCP server created with [`McpServer`](/ts-sdk/transports/open-stream.md:144)
- a [`NostrServerTransport`](src/transport/nostr-server-transport.ts) with `openStream.enabled`
- a registered tool that reads the injected stream writer from `extra._meta.stream`
- a server-managed [`OpenStreamWriter`](src/transport/open-stream/writer.ts:26) that publishes CEP-41 frames while the tool is running
- a normal final MCP return value after the stream is closed

This matches the transport implementation in [`src/transport/nostr-server-transport.ts`](src/transport/nostr-server-transport.ts), where the server creates the writer internally and injects it into `_meta.stream` for tool handlers.

In this flow, [`OpenStreamWriter.write()`](src/transport/open-stream/writer.ts:66) implicitly calls [`OpenStreamWriter.start()`](src/transport/open-stream/writer.ts:51) the first time it is needed.

The important part is that the producer emits valid CEP-41 progress frames during execution and still returns the final MCP tool result afterward.

## Live Streams and Event Sources

Open streams also fit long-lived or event-like sources where data arrives over time, such as websocket messages, subprocess output, or upstream event feeds.

The pattern is the same:

1. create an [`OpenStreamWriter`](src/transport/open-stream/writer.ts)
2. translate each upstream event into one or more [`write()`](src/transport/open-stream/writer.ts:66) calls
3. call [`close()`](src/transport/open-stream/writer.ts:112) when the upstream source ends normally
4. call [`abort()`](src/transport/open-stream/writer.ts:129) when the upstream source fails or local policy requires termination

### Example: bridging a websocket feed from a tool handler

```typescript
function getOpenStreamWriter(extra: {
  _meta?: Record&lt;string, unknown&gt;;
}): OpenStreamWriter {
  const stream = (extra._meta as { stream?: OpenStreamWriter } | undefined)
    ?.stream;

  if (!stream) {
    throw new Error('Expected open stream writer in _meta.stream');
  }

  return stream;
}

server.registerTool(
  'subscribe_to_feed',
  {
    title: 'Subscribe to feed',
    description: 'Bridges an upstream websocket feed into CEP-41 chunks',
    inputSchema: {
      url: z.string().url(),
    },
  },
  async ({ url }, extra) =&gt; {
    const stream = getOpenStreamWriter(extra);

    const socket = new WebSocket(url);

    socket.addEventListener('message', async (event) =&gt; {
      await stream.write(String(event.data));
    });

    socket.addEventListener('close', async () =&gt; {
      await stream.close();
    });

    socket.addEventListener('error', async () =&gt; {
      await stream.abort('Upstream websocket failed');
    });

    return {
      content: [{ type: 'text', text: `Subscribed to ${url}` }],
    };
  },
);
```

For this style of usage, think of CEP-41 as the transport-safe envelope for incremental application events. The stream chunks are the live payload, while the final MCP response still communicates the request outcome.

## Receiver and Registry

`OpenStreamReceiver` is the stateful inbound helper for CEP-41 progress notifications. Internally it delegates to `OpenStreamRegistry`, which tracks active sessions by `progressToken`.

This split is useful when:

- you need a simple receiver entry point for inbound `notifications/progress`
- you want direct control over session creation or lookup
- you need bounded concurrency and buffering policies across many active streams

[`OpenStreamReceiver.processFrame()`](src/transport/open-stream/receiver.ts:23) accepts a JSON-RPC notification and returns the associated session after applying sequencing and lifecycle validation.

## Policy and Safety Controls

The shared policy shape is defined by [`OpenStreamTransportPolicy`](src/transport/open-stream-policy.ts:4).

Supported controls are:

| Option | Meaning |
| --- | --- |
| `maxConcurrentStreams` | Maximum number of active sessions tracked at once |
| `maxBufferedChunksPerStream` | Maximum count of unresolved buffered chunks per stream |
| `maxBufferedBytesPerStream` | Maximum buffered chunk bytes per stream |
| `idleTimeoutMs` | Idle period before a keepalive probe is sent |
| `probeTimeoutMs` | Time to wait for the matching `pong` before failing the stream |
| `closeGracePeriodMs` | Bounded grace period after `close` when chunk gaps remain |

The default constants live in [`src/transport/open-stream/constants.ts`](src/transport/open-stream/constants.ts).

These limits exist to keep CEP-41 streams safe under normal operation and under adversarial or degraded relay conditions.

## Errors You May See

The main CEP-41 error types are defined in [`src/transport/open-stream/errors.ts`](src/transport/open-stream/errors.ts):

| Error | Meaning |
| --- | --- |
| `OpenStreamAbortError` | The remote side or local policy aborted the stream |
| `OpenStreamPolicyError` | Local admission or policy constraints rejected stream creation |
| `OpenStreamSequenceError` | The stream violated CEP-41 lifecycle, ordering, or chunk contiguity rules |

In practice, sequence errors usually indicate malformed frames, duplicate starts, stale chunks, non-increasing `progress`, or incomplete close conditions.

## Keepalive and Close Behavior

The SDK reference implementation includes the CEP-41 keepalive and termination rules implemented by [`OpenStreamSession`](src/transport/open-stream/session.ts):

- valid activity refreshes the idle timer
- idle streams can trigger `ping`
- unmatched or invalid `pong` traffic does not satisfy liveness
- streams can abort after probe timeout
- a `close` with unresolved chunk gaps can wait briefly and then abort if the grace period expires

This behavior aligns with the reference implementation tested in [`src/transport/open-stream/session.test.ts`](src/transport/open-stream/session.test.ts) and [`src/transport/open-stream/registry.test.ts`](src/transport/open-stream/registry.test.ts).

## Relationship to the CEP

For protocol-level semantics, validation rules, and wire examples, refer to [CEP-41: Open-Ended Stream Transfer](/spec/ceps/cep-41).

This SDK page focuses on how those semantics map onto the TypeScript API surface.

## Related Documentation

- [CEP-41: Open-Ended Stream Transfer](/spec/ceps/cep-41)
- [Oversized Transfer](/ts-sdk/transports/oversized-transfer)
- [Nostr Client Transport](/ts-sdk/transports/nostr-client-transport)
- [Nostr Server Transport](/ts-sdk/transports/nostr-server-transport)
