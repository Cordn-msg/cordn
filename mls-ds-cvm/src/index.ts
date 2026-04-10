import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import process from 'node:process';

import { ApplesauceRelayPool, NostrServerTransport, PrivateKeySigner } from '@contextvm/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

type BridgeSuccess<T extends JsonObject = JsonObject> = {
  id: string;
  ok: true;
  result: T;
};

type BridgeFailure = {
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Json;
  };
};

type BridgeResponse<T extends JsonObject = JsonObject> = BridgeSuccess<T> | BridgeFailure;

const identityRecordSchema = z.object({
  stable_identity: z.string(),
  delivery_addresses: z.array(z.string()),
});

const keyPackageSchema = z.object({
  key_package_ref: z.string(),
  key_package: z.string(),
});

const bridgeInfoSchema = z.object({
  status: z.string(),
  contract: z.string(),
  bridge: z.string(),
  database_path: z.string(),
});

const registeredResultSchema = z.object({
  registered: z.boolean(),
});

const storedResultSchema = z.object({
  stored: z.boolean(),
});

const clientsResultSchema = z.object({
  clients: z.array(identityRecordSchema),
});

const publishedResultSchema = z.object({
  published: z.number().int().nonnegative(),
});

const keyPackagesResultSchema = z.object({
  key_packages: z.array(keyPackageSchema),
});

const keyPackageResultSchema = z.object({
  key_package: keyPackageSchema,
});

const welcomeMessageSchema = z.object({
  stable_identity: z.string(),
  key_package_ref: z.string(),
  message_bytes: z.string(),
});

const welcomesResultSchema = z.object({
  welcomes: z.array(welcomeMessageSchema),
});

const groupMessageSchema = z.object({
  group_id: z.string(),
  epoch: z.number().int().nonnegative(),
  sender: z.string(),
  recipients: z.array(z.string()),
  message_bytes: z.string(),
});

const messagesResultSchema = z.object({
  messages: z.array(groupMessageSchema),
});

type StructuredResult<TSchema extends z.ZodType<JsonObject>> = z.infer<TSchema>;

class RustBridgeClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: JsonObject) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private nextId = 0;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = createInterface({ input: this.child.stdout });
    stdout.on('line', (line) => this.handleLine(line));

    this.child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
    });

    this.child.on('exit', (code, signal) => {
      const error = new Error(`Rust bridge exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      for (const { reject } of this.pending.values()) {
        reject(error);
      }
      this.pending.clear();
    });
  }

  async call<T extends JsonObject>(method: string, params: JsonObject): Promise<T> {
    const id = `req-${++this.nextId}`;
    const payload = JSON.stringify({ id, method, params });

    const response = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.child.stdin.write(`${payload}\n`);
    return response as Promise<T>;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  private handleLine(line: string): void {
    const parsed = JSON.parse(line) as BridgeResponse;
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }

    this.pending.delete(parsed.id);

    if (parsed.ok) {
      pending.resolve(parsed.result);
      return;
    }

    const error = new Error(`${parsed.error.code}: ${parsed.error.message}`);
    (error as Error & { details?: Json }).details = parsed.error.details;
    pending.reject(error);
  }
}

const bridgeCommand = process.env.MLS_DS_BRIDGE_COMMAND ?? 'cargo';
const bridgeArgs = (process.env.MLS_DS_BRIDGE_ARGS ?? 'run -q -p mls-ds-server').split(' ');
const bridgeEnv = {
  ...process.env,
  MLS_DS_DB_PATH: process.env.MLS_DS_DB_PATH ?? ':memory:',
};

const bridge = new RustBridgeClient(bridgeCommand, bridgeArgs, bridgeEnv);

function asStructuredContent(value: JsonObject): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function jsonResult<TSchema extends z.ZodType<JsonObject>>(
  schema: TSchema,
  result: StructuredResult<TSchema>,
) {
  const parsed = schema.parse(result);
  return {
    content: [{ type: 'text' as const, text: '' }],
    structuredContent: asStructuredContent(parsed),
  };
}

const server = new McpServer({
  name: 'mls-ds-cvm',
  version: '0.1.0',
});

server.registerTool(
  'bridge_info',
  {
    description: 'Return Rust bridge status and contract metadata.',
    inputSchema: z.object({}),
    outputSchema: bridgeInfoSchema,
  },
  async () => {
    const result = await bridge.call<StructuredResult<typeof bridgeInfoSchema>>('bridge_info', {});
    return jsonResult(bridgeInfoSchema, result);
  },
);

server.registerTool(
  'register_client',
  {
    description: 'Register or update a stable identity and its delivery addresses.',
    inputSchema: z.object({
      stable_identity: z.string(),
      delivery_addresses: z.array(z.string()),
    }),
    outputSchema: registeredResultSchema,
  },
  async (args) => {
    const result = await bridge.call<StructuredResult<typeof registeredResultSchema>>(
      'register_client',
      args as JsonObject,
    );
    return jsonResult(registeredResultSchema, result);
  },
);

server.registerTool(
  'list_clients',
  {
    description: 'List registered stable identities.',
    inputSchema: z.object({}),
    outputSchema: clientsResultSchema,
  },
  async () => {
    const result = await bridge.call<StructuredResult<typeof clientsResultSchema>>('list_clients', {});
    return jsonResult(clientsResultSchema, result);
  },
);

server.registerTool(
  'publish_key_packages',
  {
    description: 'Publish OpenMLS key packages for a stable identity.',
    inputSchema: z.object({
      stable_identity: z.string(),
      key_packages: z.array(
        keyPackageSchema,
      ),
    }),
    outputSchema: publishedResultSchema,
  },
  async (args) => {
    const result = await bridge.call<StructuredResult<typeof publishedResultSchema>>(
      'publish_key_packages',
      args as JsonObject,
    );
    return jsonResult(publishedResultSchema, result);
  },
);

server.registerTool(
  'get_key_packages',
  {
    description: 'List published key packages for a stable identity.',
    inputSchema: z.object({ stable_identity: z.string() }),
    outputSchema: keyPackagesResultSchema,
  },
  async (args) => {
    const result = await bridge.call<StructuredResult<typeof keyPackagesResultSchema>>(
      'get_key_packages',
      args as JsonObject,
    );
    return jsonResult(keyPackagesResultSchema, result);
  },
);

server.registerTool(
  'consume_key_package',
  {
    description: 'Reserve and consume one key package for a stable identity.',
    inputSchema: z.object({ stable_identity: z.string() }),
    outputSchema: keyPackageResultSchema,
  },
  async (args) => {
    const result = await bridge.call<StructuredResult<typeof keyPackageResultSchema>>(
      'consume_key_package',
      args as JsonObject,
    );
    return jsonResult(keyPackageResultSchema, result);
  },
);

server.registerTool(
  'put_group_route',
  {
    description: 'Store or replace the delivery route for a group.',
    inputSchema: z.object({
      group_id: z.string(),
      epoch: z.number().int().nonnegative(),
      members: z.array(z.string()),
    }),
    outputSchema: storedResultSchema,
  },
  async (args) => {
    const result = await bridge.call<StructuredResult<typeof storedResultSchema>>(
      'put_group_route',
      args as JsonObject,
    );
    return jsonResult(storedResultSchema, result);
  },
);

server.registerTool(
  'send_welcome',
  {
    description: 'Store a welcome message targeted by stable identity and reserved key package reference.',
    inputSchema: z.object({
      stable_identity: z.string(),
      key_package_ref: z.string(),
      message_bytes: z.string(),
    }),
    outputSchema: storedResultSchema,
  },
  async (args) => {
    const result = await bridge.call<StructuredResult<typeof storedResultSchema>>(
      'send_welcome',
      args as JsonObject,
    );
    return jsonResult(storedResultSchema, result);
  },
);

server.registerTool(
  'recv_welcomes',
  {
    description: 'Drain welcome messages for a stable identity.',
    inputSchema: z.object({ stable_identity: z.string() }),
    outputSchema: welcomesResultSchema,
  },
  async (args) => {
    const result = await bridge.call<StructuredResult<typeof welcomesResultSchema>>(
      'recv_welcomes',
      args as JsonObject,
    );
    return jsonResult(welcomesResultSchema, result);
  },
);

server.registerTool(
  'send_message',
  {
    description: 'Store a group message for routed recipients.',
    inputSchema: z.object({
      group_id: z.string(),
      epoch: z.number().int().nonnegative(),
      sender: z.string(),
      recipients: z.array(z.string()),
      message_bytes: z.string(),
    }),
    outputSchema: storedResultSchema,
  },
  async (args) => {
    const result = await bridge.call<StructuredResult<typeof storedResultSchema>>(
      'send_message',
      args as JsonObject,
    );
    return jsonResult(storedResultSchema, result);
  },
);

server.registerTool(
  'recv_messages',
  {
    description: 'Drain queued group messages for a delivery address.',
    inputSchema: z.object({ delivery_address: z.string() }),
    outputSchema: messagesResultSchema,
  },
  async (args) => {
    const result = await bridge.call<StructuredResult<typeof messagesResultSchema>>(
      'recv_messages',
      args as JsonObject,
    );
    return jsonResult(messagesResultSchema, result);
  },
);

async function main(): Promise<void> {
  const privateKey = process.env.CVM_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('CVM_PRIVATE_KEY is required');
  }

  const relayUrls = (process.env.CVM_RELAY_URLS ?? 'wss://relay.contextvm.org')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const transport = new NostrServerTransport({
    signer: new PrivateKeySigner(privateKey),
    relayHandler: new ApplesauceRelayPool(relayUrls),
    serverInfo: {
      name: 'MLS DS CVM Wrapper',
      about: 'ContextVM wrapper over the Rust MLS delivery service bridge',
    },
    isAnnouncedServer: false,
  });

  const shutdown = async (): Promise<void> => {
    await bridge.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await server.connect(transport);
}

void main().catch(async (error) => {
  console.error(error);
  await bridge.close();
  process.exit(1);
});
