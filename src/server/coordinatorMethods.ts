import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenStreamWriter } from "@contextvm/sdk/transport";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { verifyEvent, type NostrEvent } from "nostr-tools";
import type { z } from "zod";
import {
  isDefaultCredential,
  keyPackageDecoder,
  mlsMessageDecoder,
  type KeyPackage,
  type Welcome,
} from "ts-mls";

import { Coordinator } from "../coordinator/coordinator.ts";
import {
  consumeKeyPackageInputSchema,
  consumeKeyPackageOutputSchema,
  COORDINATOR_METHODS,
  fetchGroupMessagesInputSchema,
  fetchGroupMessagesOutputSchema,
  fetchPendingWelcomesInputSchema,
  fetchPendingWelcomesOutputSchema,
  groupMessageSchema,
  listAvailableKeyPackagesInputSchema,
  listAvailableKeyPackagesOutputSchema,
  postGroupMessageInputSchema,
  postGroupMessageOutputSchema,
  publishKeyPackageInputSchema,
  publishKeyPackageOutputSchema,
  removeKeyPackagesInputSchema,
  removeKeyPackagesOutputSchema,
  storeWelcomeInputSchema,
  storeWelcomeOutputSchema,
  subscribeGroupMessagesInputSchema,
  subscribeGroupMessagesOutputSchema,
} from "../contracts/index.ts";
import { decodeExact, decodeWelcome, encodeWelcome } from "../mlsCodec.ts";
import { assertNonEmptyBase64, encodeBase64 } from "./base64.ts";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type ResolveRequestEvent = (requestEventId: string) => NostrEvent | null;

function decodeKeyPackageBase64(kp_64: string): KeyPackage {
  try {
    return decodeExact(
      assertNonEmptyBase64(kp_64, "kp_64"),
      keyPackageDecoder,
      "kp_64",
    );
  } catch {
    throw new Error("Invalid kp_64");
  }
}

function decodeWelcomeBase64(welcome_64: string): Welcome {
  try {
    return decodeWelcome(
      assertNonEmptyBase64(welcome_64, "welcome_64"),
      "welcome_64",
    );
  } catch {
    throw new Error("Invalid welcome_64");
  }
}

function encodeWelcomeBase64(welcome: Welcome): string {
  return encodeBase64(encodeWelcome(welcome));
}

function decodeOpaqueMessageBase64(msg_64: string): Uint8Array {
  try {
    const bytes = assertNonEmptyBase64(msg_64, "msg_64");
    decodeExact(bytes, mlsMessageDecoder, "msg_64");
    return bytes;
  } catch {
    throw new Error("Invalid msg_64");
  }
}

function requireClientPubkey(extra: ToolExtra): string {
  const clientPubkey = extra._meta?.clientPubkey;
  if (typeof clientPubkey !== "string" || clientPubkey.length === 0) {
    throw new Error("Missing injected client pubkey");
  }

  return clientPubkey;
}

function getRequestEventId(extra: ToolExtra): string | null {
  const requestEventId = extra._meta?.requestEventId;
  return typeof requestEventId === "string" && requestEventId.length > 0
    ? requestEventId
    : null;
}

function readStablePubkeyFromCredential(keyPackage: KeyPackage): string {
  const credential = keyPackage.leafNode.credential;
  if (
    !isDefaultCredential(credential) ||
    credential.credentialType !== 1 ||
    !("identity" in credential)
  ) {
    throw new Error("Only BasicCredential key packages are supported");
  }

  return new TextDecoder().decode(credential.identity);
}

async function verifyPublishedKeyPackageBinding(params: {
  clientPubkey: string;
  publicationEvent: NostrEvent;
  keyPackage: KeyPackage;
}): Promise<string> {
  if (!verifyEvent(params.publicationEvent)) {
    throw new Error("Invalid publication event signature");
  }

  if (params.publicationEvent.pubkey !== params.clientPubkey) {
    throw new Error(
      "Publication event signer does not match injected client pubkey",
    );
  }

  const stablePubkey = readStablePubkeyFromCredential(params.keyPackage);
  if (stablePubkey !== params.publicationEvent.pubkey) {
    throw new Error(
      "Key package credential identity does not match publication event signer",
    );
  }

  return stablePubkey;
}

function mapAvailableKeyPackage(record: {
  stablePubkey: string;
  keyPackageRef: string;
  isLastResort: boolean;
  publishedAt: number;
}) {
  return {
    pk: record.stablePubkey,
    kp_ref: record.keyPackageRef,
    last_resort: record.isLastResort,
    at: record.publishedAt,
  };
}

function getOpenStreamWriter(extra: ToolExtra): OpenStreamWriter {
  const stream = (extra._meta as { stream?: OpenStreamWriter } | undefined)
    ?.stream;

  if (!stream) {
    throw new Error("Expected open stream writer in _meta.stream");
  }

  return stream;
}

function mapGroupMessage(record: {
  cursor: number;
  groupId: string;
  opaqueMessage: Uint8Array;
  createdAt: number;
}) {
  return groupMessageSchema.parse({
    cursor: record.cursor,
    gid: record.groupId,
    msg_64: encodeBase64(record.opaqueMessage),
    at: record.createdAt,
  });
}

export class CoordinatorAdapter {
  private readonly coordinator: Coordinator;
  private readonly resolveRequestEvent?: ResolveRequestEvent;

  constructor(
    coordinator: Coordinator,
    resolveRequestEvent?: ResolveRequestEvent,
  ) {
    this.coordinator = coordinator;
    this.resolveRequestEvent = resolveRequestEvent;
  }

  async publishKeyPackage(
    input: z.infer<typeof publishKeyPackageInputSchema>,
    extra: ToolExtra,
  ) {
    const clientPubkey = requireClientPubkey(extra);
    const keyPackage = decodeKeyPackageBase64(input.kp_64);
    const requestEventId = getRequestEventId(extra);
    const publicationEvent = requestEventId
      ? this.resolveRequestEvent?.(requestEventId)
      : undefined;
    if (!publicationEvent) {
      throw new Error("Missing publication event");
    }

    const stablePubkey = await verifyPublishedKeyPackageBinding({
      clientPubkey,
      publicationEvent,
      keyPackage,
    });

    const record = this.coordinator.publishKeyPackage({
      stablePubkey,
      keyPackageRef: input.kp_ref,
      keyPackage,
      publicationEvent,
    });

    return {
      content: [],
      structuredContent: {
        kp_ref: record.keyPackageRef,
        last_resort: record.isLastResort,
        at: record.publishedAt,
      },
    };
  }

  consumeKeyPackage(input: z.infer<typeof consumeKeyPackageInputSchema>) {
    const record = this.coordinator.consumeKeyPackage(input.id);

    return {
      content: [],
      structuredContent: {
        keyPackage: record
          ? {
              pk: record.stablePubkey,
              kp_ref: record.keyPackageRef,
              last_resort: record.isLastResort,
              at: record.publishedAt,
              event: record.publicationEvent,
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
        keyPackages: records.map(mapAvailableKeyPackage),
      },
    };
  }

  removeKeyPackages(
    input: z.infer<typeof removeKeyPackagesInputSchema>,
    extra: ToolExtra,
  ) {
    const clientPubkey = requireClientPubkey(extra);
    const records = input.kp_refs.map((kp_ref) => {
      const record = this.coordinator.getKeyPackage(kp_ref);
      if (!record) {
        throw new Error(`Unknown key package ref: ${kp_ref}`);
      }

      if (record.stablePubkey !== clientPubkey) {
        throw new Error(`Unauthorized key package ref: ${kp_ref}`);
      }

      return record;
    });

    return {
      content: [],
      structuredContent: {
        kp_refs: records.map((record) => {
          return (
            this.coordinator.removeKeyPackage(record.keyPackageRef)
              ?.keyPackageRef ?? record.keyPackageRef
          );
        }),
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
          kp_ref: record.keyPackageReference,
          welcome_64: encodeWelcomeBase64(record.welcome),
          at: record.createdAt,
        })),
      },
    };
  }

  storeWelcome(input: z.infer<typeof storeWelcomeInputSchema>) {
    const record = this.coordinator.storeWelcome({
      targetStablePubkey: input.target_pk,
      keyPackageReference: input.kp_ref,
      welcome: decodeWelcomeBase64(input.welcome_64),
    });

    return {
      content: [],
      structuredContent: {
        at: record.createdAt,
      },
    };
  }

  postGroupMessage(
    input: z.infer<typeof postGroupMessageInputSchema>,
    extra: ToolExtra,
  ) {
    const record = this.coordinator.postGroupMessage({
      ephemeralSenderPubkey: requireClientPubkey(extra),
      opaqueMessage: decodeOpaqueMessageBase64(input.msg_64),
    });

    return {
      content: [],
      structuredContent: {
        cursor: record.cursor,
        gid: record.groupId,
        at: record.createdAt,
      },
    };
  }

  fetchGroupMessages(input: z.infer<typeof fetchGroupMessagesInputSchema>) {
    const records = this.coordinator.fetchGroupMessages({
      groupId: input.gid,
      afterCursor: input.after,
    });

    return {
      content: [],
      structuredContent: {
        messages: records.map(mapGroupMessage),
      },
    };
  }

  async subscribeGroupMessages(
    input: z.infer<typeof subscribeGroupMessagesInputSchema>,
    extra: ToolExtra,
  ) {
    const stream = getOpenStreamWriter(extra);
    const backlog = this.coordinator.fetchGroupMessages({
      groupId: input.gid,
      afterCursor: input.after,
    });
    const subscription = this.coordinator.subscribeGroupMessages({
      groupId: input.gid,
      afterCursor: input.after,
    });
    let lastEmittedCursor = input.after ?? 0;
    const originalAbort = stream.abort.bind(stream);

    stream.abort = async (reason?: string): Promise<void> => {
      subscription.unsubscribe();
      await originalAbort(reason);
    };

    try {
      await stream.start();

      for (const record of backlog) {
        const message = mapGroupMessage(record);
        await stream.write(JSON.stringify(message));
        lastEmittedCursor = record.cursor;
      }

      for await (const record of subscription.messages) {
        if (record.cursor <= lastEmittedCursor) {
          continue;
        }

        const message = mapGroupMessage(record);
        await stream.write(JSON.stringify(message));
        lastEmittedCursor = record.cursor;
      }

      if (stream.isActive) {
        await stream.close();
      }
    } catch (error) {
      try {
        await stream.abort(
          error instanceof Error ? error.message : "Stream aborted",
        );
      } catch {
        // Ignore secondary abort cleanup failures.
      }
      throw error;
    } finally {
      stream.abort = originalAbort;
      subscription.unsubscribe();
    }

    return {
      content: [],
      structuredContent: {
        subscribed: true,
      },
    };
  }
}

export function registerCoordinatorMethods(
  server: McpServer,
  adapter: CoordinatorAdapter,
): void {
  // TODO: Store the entire key package publish event
  server.registerTool(
    COORDINATOR_METHODS.publishKeyPackage,
    {
      description:
        "Publish an MLS key package for the injected caller identity.",
      inputSchema: publishKeyPackageInputSchema,
      outputSchema: publishKeyPackageOutputSchema,
    },
    async (input, extra) => adapter.publishKeyPackage(input, extra),
  );

  server.registerTool(
    COORDINATOR_METHODS.listAvailableKeyPackages,
    {
      description:
        "List currently available published MLS key packages discoverable on the coordinator.",
      inputSchema: listAvailableKeyPackagesInputSchema,
      outputSchema: listAvailableKeyPackagesOutputSchema,
    },
    (input) => adapter.listAvailableKeyPackages(input),
  );

  server.registerTool(
    COORDINATOR_METHODS.removeKeyPackages,
    {
      description:
        "Remove published MLS key packages owned by the injected caller identity.",
      inputSchema: removeKeyPackagesInputSchema,
      outputSchema: removeKeyPackagesOutputSchema,
    },
    (input, extra) => adapter.removeKeyPackages(input, extra),
  );
  // TODO: Return the entire key package publish event
  server.registerTool(
    COORDINATOR_METHODS.consumeKeyPackage,
    {
      description:
        "Consume the next published MLS key package by stable identity or exact key package ref.",
      inputSchema: consumeKeyPackageInputSchema,
      outputSchema: consumeKeyPackageOutputSchema,
    },
    (input) => adapter.consumeKeyPackage(input),
  );

  server.registerTool(
    COORDINATOR_METHODS.fetchPendingWelcomes,
    {
      description:
        "Fetch and drain welcomes queued for the injected caller identity.",
      inputSchema: fetchPendingWelcomesInputSchema,
      outputSchema: fetchPendingWelcomesOutputSchema,
    },
    (input, extra) => adapter.fetchPendingWelcomes(input, extra),
  );

  server.registerTool(
    COORDINATOR_METHODS.storeWelcome,
    {
      description: "Store an MLS welcome for a target stable identity.",
      inputSchema: storeWelcomeInputSchema,
      outputSchema: storeWelcomeOutputSchema,
    },
    (input) => adapter.storeWelcome(input),
  );

  server.registerTool(
    COORDINATOR_METHODS.postGroupMessage,
    {
      description:
        "Queue an MLS opaque group message for the injected caller identity.",
      inputSchema: postGroupMessageInputSchema,
      outputSchema: postGroupMessageOutputSchema,
    },
    (input, extra) => adapter.postGroupMessage(input, extra),
  );

  server.registerTool(
    COORDINATOR_METHODS.fetchGroupMessages,
    {
      description:
        "Fetch queued MLS opaque group messages by group and optional cursor.",
      inputSchema: fetchGroupMessagesInputSchema,
      outputSchema: fetchGroupMessagesOutputSchema,
    },
    (input) => adapter.fetchGroupMessages(input),
  );

  server.registerTool(
    COORDINATOR_METHODS.subscribeGroupMessages,
    {
      description:
        "Replay and stream MLS opaque group messages by group and optional cursor.",
      inputSchema: subscribeGroupMessagesInputSchema,
      outputSchema: subscribeGroupMessagesOutputSchema,
    },
    (input, extra) => adapter.subscribeGroupMessages(input, extra),
  );
}
