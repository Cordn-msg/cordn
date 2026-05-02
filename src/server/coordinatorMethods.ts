import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  encode,
  keyPackageDecoder,
  keyPackageEncoder,
  mlsMessageDecoder,
  mlsMessageEncoder,
  protocolVersions,
  wireformats,
  type KeyPackage,
  type Welcome,
} from "ts-mls";

import { Coordinator } from "../coordinator/coordinator.ts";
import {
  consumeKeyPackageInputSchema,
  consumeKeyPackageOutputSchema,
  CONTEXTVM_COORDINATOR_TOOLS,
  fetchGroupMessagesInputSchema,
  fetchGroupMessagesOutputSchema,
  fetchPendingWelcomesInputSchema,
  fetchPendingWelcomesOutputSchema,
  listAvailableKeyPackagesInputSchema,
  listAvailableKeyPackagesOutputSchema,
  postGroupMessageInputSchema,
  postGroupMessageOutputSchema,
  publishKeyPackageInputSchema,
  publishKeyPackageOutputSchema,
  storeWelcomeInputSchema,
  storeWelcomeOutputSchema,
} from "../contracts/index.ts";
import { assertNonEmptyBase64, encodeBase64 } from "./base64.ts";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type Decoder<T> = (
  bytes: Uint8Array,
  offset: number,
) => [T, number] | undefined;
// TODO: Duplicated function
function decodeExact<T>(
  bytes: Uint8Array,
  decoder: Decoder<T>,
  label: string,
): T {
  const decoded = decoder(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length) {
    throw new Error(`Invalid ${label}`);
  }

  return decoded[0];
}

function decodeKeyPackageBase64(keyPackageBase64: string): KeyPackage {
  try {
    return decodeExact(
      assertNonEmptyBase64(keyPackageBase64, "keyPackageBase64"),
      keyPackageDecoder,
      "keyPackageBase64",
    );
  } catch {
    throw new Error("Invalid keyPackageBase64");
  }
}

function decodeWelcomeBase64(welcomeBase64: string): Welcome {
  try {
    const message = decodeExact(
      assertNonEmptyBase64(welcomeBase64, "welcomeBase64"),
      mlsMessageDecoder,
      "welcomeBase64",
    );

    if (message.wireformat !== wireformats.mls_welcome) {
      throw new Error("Invalid welcomeBase64");
    }

    return message.welcome;
  } catch {
    throw new Error("Invalid welcomeBase64");
  }
}

function encodeWelcomeBase64(welcome: Welcome): string {
  return encodeBase64(
    encode(mlsMessageEncoder, {
      version: protocolVersions.mls10,
      wireformat: wireformats.mls_welcome,
      welcome,
    }),
  );
}

function decodeOpaqueMessageBase64(opaqueMessageBase64: string): Uint8Array {
  try {
    const bytes = assertNonEmptyBase64(
      opaqueMessageBase64,
      "opaqueMessageBase64",
    );
    decodeExact(bytes, mlsMessageDecoder, "opaqueMessageBase64");
    return bytes;
  } catch {
    throw new Error("Invalid opaqueMessageBase64");
  }
}

function requireClientPubkey(extra: ToolExtra): string {
  const clientPubkey = extra._meta?.clientPubkey;
  if (typeof clientPubkey !== "string" || clientPubkey.length === 0) {
    throw new Error("Missing injected client pubkey");
  }

  return clientPubkey;
}

export class CoordinatorAdapter {
  private readonly coordinator: Coordinator;

  constructor(coordinator: Coordinator) {
    this.coordinator = coordinator;
  }

  publishKeyPackage(
    input: z.infer<typeof publishKeyPackageInputSchema>,
    extra: ToolExtra,
  ) {
    const record = this.coordinator.publishKeyPackage({
      stablePubkey: requireClientPubkey(extra),
      keyPackageRef: input.keyPackageRef,
      keyPackage: decodeKeyPackageBase64(input.keyPackageBase64),
    });

    return {
      content: [],
      structuredContent: {
        keyPackageRef: record.keyPackageRef,
        publishedAt: record.publishedAt,
      },
    };
  }

  consumeKeyPackage(input: z.infer<typeof consumeKeyPackageInputSchema>) {
    const record = this.coordinator.consumeKeyPackage(input.identifier);

    return {
      content: [],
      structuredContent: {
        keyPackage: record
          ? {
              stablePubkey: record.stablePubkey,
              keyPackageRef: record.keyPackageRef,
              keyPackageBase64: encodeBase64(
                encode(keyPackageEncoder, record.keyPackage),
              ),
              publishedAt: record.publishedAt,
            }
          : null,
      },
    };
  }

  listAvailableKeyPackages(
    _input: z.infer<typeof listAvailableKeyPackagesInputSchema>,
  ) {
    const records = this.coordinator.listAllKeyPackages();

    return {
      content: [],
      structuredContent: {
        keyPackages: records.map((record) => ({
          stablePubkey: record.stablePubkey,
          keyPackageRef: record.keyPackageRef,
          publishedAt: record.publishedAt,
        })),
      },
    };
  }

  fetchPendingWelcomes(
    _input: z.infer<typeof fetchPendingWelcomesInputSchema>,
    extra: ToolExtra,
  ) {
    const records = this.coordinator.fetchPendingWelcomes(
      requireClientPubkey(extra),
    );

    return {
      content: [],
      structuredContent: {
        welcomes: records.map((record) => ({
          keyPackageReference: record.keyPackageReference,
          welcomeBase64: encodeWelcomeBase64(record.welcome),
          createdAt: record.createdAt,
        })),
      },
    };
  }

  storeWelcome(input: z.infer<typeof storeWelcomeInputSchema>) {
    const record = this.coordinator.storeWelcome({
      targetStablePubkey: input.targetStablePubkey,
      keyPackageReference: input.keyPackageReference,
      welcome: decodeWelcomeBase64(input.welcomeBase64),
    });

    return {
      content: [],
      structuredContent: {
        createdAt: record.createdAt,
      },
    };
  }

  postGroupMessage(
    input: z.infer<typeof postGroupMessageInputSchema>,
    extra: ToolExtra,
  ) {
    const record = this.coordinator.postGroupMessage({
      ephemeralSenderPubkey: requireClientPubkey(extra),
      opaqueMessage: decodeOpaqueMessageBase64(input.opaqueMessageBase64),
    });

    return {
      content: [],
      structuredContent: {
        cursor: record.cursor,
        groupId: record.groupId,
        createdAt: record.createdAt,
      },
    };
  }

  fetchGroupMessages(input: z.infer<typeof fetchGroupMessagesInputSchema>) {
    const records = this.coordinator.fetchGroupMessages(input);

    return {
      content: [],
      structuredContent: {
        messages: records.map((record) => ({
          cursor: record.cursor,
          groupId: record.groupId,
          opaqueMessageBase64: encodeBase64(record.opaqueMessage),
          createdAt: record.createdAt,
        })),
      },
    };
  }
}

export function registerCoordinatorMethods(
  server: McpServer,
  adapter: CoordinatorAdapter,
): void {
  server.registerTool(
    CONTEXTVM_COORDINATOR_TOOLS.publishKeyPackage,
    {
      description:
        "Publish an MLS key package for the injected caller identity.",
      inputSchema: publishKeyPackageInputSchema,
      outputSchema: publishKeyPackageOutputSchema,
    },
    (input, extra) => adapter.publishKeyPackage(input, extra),
  );

  server.registerTool(
    CONTEXTVM_COORDINATOR_TOOLS.listAvailableKeyPackages,
    {
      description:
        "List currently available published MLS key packages discoverable on the coordinator.",
      inputSchema: listAvailableKeyPackagesInputSchema,
      outputSchema: listAvailableKeyPackagesOutputSchema,
    },
    (input) => adapter.listAvailableKeyPackages(input),
  );

  server.registerTool(
    CONTEXTVM_COORDINATOR_TOOLS.consumeKeyPackage,
    {
      description:
        "Consume the next published MLS key package by stable identity or exact key package ref.",
      inputSchema: consumeKeyPackageInputSchema,
      outputSchema: consumeKeyPackageOutputSchema,
    },
    (input) => adapter.consumeKeyPackage(input),
  );

  server.registerTool(
    CONTEXTVM_COORDINATOR_TOOLS.fetchPendingWelcomes,
    {
      description:
        "Fetch and drain welcomes queued for the injected caller identity.",
      inputSchema: fetchPendingWelcomesInputSchema,
      outputSchema: fetchPendingWelcomesOutputSchema,
    },
    (input, extra) => adapter.fetchPendingWelcomes(input, extra),
  );

  server.registerTool(
    CONTEXTVM_COORDINATOR_TOOLS.storeWelcome,
    {
      description: "Store an MLS welcome for a target stable identity.",
      inputSchema: storeWelcomeInputSchema,
      outputSchema: storeWelcomeOutputSchema,
    },
    (input) => adapter.storeWelcome(input),
  );

  server.registerTool(
    CONTEXTVM_COORDINATOR_TOOLS.postGroupMessage,
    {
      description:
        "Queue an MLS opaque group message for the injected caller identity.",
      inputSchema: postGroupMessageInputSchema,
      outputSchema: postGroupMessageOutputSchema,
    },
    (input, extra) => adapter.postGroupMessage(input, extra),
  );

  server.registerTool(
    CONTEXTVM_COORDINATOR_TOOLS.fetchGroupMessages,
    {
      description:
        "Fetch queued MLS opaque group messages by group and optional cursor.",
      inputSchema: fetchGroupMessagesInputSchema,
      outputSchema: fetchGroupMessagesOutputSchema,
    },
    (input) => adapter.fetchGroupMessages(input),
  );
}
