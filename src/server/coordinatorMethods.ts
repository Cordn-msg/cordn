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
  type KeyPackage,
  type Welcome,
} from "ts-mls";

import { isLastResortKeyPackage } from "../lastResortKeyPackage.ts";
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
import {
  TokenBucketRateLimiter,
  type TokenBucketRateLimitConfig,
} from "./rateLimit.ts";
import { consoleServerLogger, type ServerLogger } from "./logger.ts";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type ResolveRequestEvent = (requestEventId: string) => NostrEvent | null;
const credentialIdentityDecoder = new TextDecoder();

export interface AbuseProtectionOptions {
  rateLimit: TokenBucketRateLimitConfig;
  keyPackageQuota: {
    maxPerIdentity: number;
    maxLastResortPerIdentity: number;
  };
  logRejections: boolean;
}

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
    return assertNonEmptyBase64(msg_64, "msg_64");
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

  return credentialIdentityDecoder.decode(credential.identity);
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
}): z.infer<typeof groupMessageSchema> {
  return {
    cursor: record.cursor,
    gid: record.groupId,
    msg_64: encodeBase64(record.opaqueMessage),
    at: record.createdAt,
  };
}

export class CoordinatorAdapter {
  private readonly coordinator: Coordinator;
  private readonly resolveRequestEvent?: ResolveRequestEvent;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly abuseProtection: AbuseProtectionOptions;
  private readonly logger: ServerLogger;
  private readonly metrics = new Map<string, number>();

  constructor(
    coordinator: Coordinator,
    resolveRequestEvent?: ResolveRequestEvent,
    abuseProtection?: AbuseProtectionOptions,
    logger: ServerLogger = consoleServerLogger,
  ) {
    this.coordinator = coordinator;
    this.resolveRequestEvent = resolveRequestEvent;
    this.abuseProtection = abuseProtection ?? {
      rateLimit: {
        enabled: true,
        refillPerMinute: 500,
        burst: 160,
        idleTtlMs: 3_600_000,
      },
      keyPackageQuota: {
        maxPerIdentity: 50,
        maxLastResortPerIdentity: 1,
      },
      logRejections: true,
    };
    this.rateLimiter = new TokenBucketRateLimiter(
      this.abuseProtection.rateLimit,
    );
    this.logger = logger;
  }

  private recordOperation(methodName: string): void {
    const count = (this.metrics.get(methodName) ?? 0) + 1;
    this.metrics.set(methodName, count);
    this.logger.info(
      { type: "operation", method: methodName, count },
      "cordn operation",
    );
  }

  assertWithinRateLimit(extra: ToolExtra, methodName: string): void {
    const clientPubkey = requireClientPubkey(extra);
    if (this.rateLimiter.check(clientPubkey)) {
      return;
    }

    if (this.abuseProtection.logRejections) {
      this.logger.warn(
        {
          type: "rate_limit",
          method: methodName,
          clientPubkey: `${clientPubkey.slice(0, 12)}…`,
        },
        "cordn abuse protection rejection",
      );
    }

    throw new Error("Rate limit exceeded");
  }

  private enforceKeyPackageQuota(
    stablePubkey: string,
    incomingKeyPackage: KeyPackage,
  ): void {
    const records = this.coordinator.listKeyPackagesForIdentity(stablePubkey);
    const incomingIsLastResort = isLastResortKeyPackage(incomingKeyPackage);
    const maxPerIdentity = this.abuseProtection.keyPackageQuota.maxPerIdentity;
    const maxLastResortPerIdentity =
      this.abuseProtection.keyPackageQuota.maxLastResortPerIdentity;

    if (incomingIsLastResort) {
      const existingLastResortRecords = records.filter(
        (record) => record.isLastResort,
      );

      if (
        maxLastResortPerIdentity > 0 &&
        existingLastResortRecords.length >= maxLastResortPerIdentity
      ) {
        const recordsToRemove = existingLastResortRecords.slice(
          0,
          existingLastResortRecords.length - maxLastResortPerIdentity + 1,
        );
        for (const record of recordsToRemove) {
          this.coordinator.removeKeyPackage(record.keyPackageRef);
        }
      }

      const nonLastResortCount =
        records.length - existingLastResortRecords.length;
      if (
        maxPerIdentity > 0 &&
        nonLastResortCount +
          Math.min(
            existingLastResortRecords.length,
            maxLastResortPerIdentity - 1,
          ) +
          1 >
          maxPerIdentity
      ) {
        this.logQuotaRejection(
          stablePubkey,
          "max key packages per identity exceeded",
        );
        throw new Error("Key package quota exceeded");
      }

      return;
    }

    if (maxPerIdentity > 0 && records.length >= maxPerIdentity) {
      this.logQuotaRejection(
        stablePubkey,
        "max key packages per identity exceeded",
      );
      throw new Error("Key package quota exceeded");
    }
  }

  private logQuotaRejection(clientPubkey: string, reason: string): void {
    if (!this.abuseProtection.logRejections) {
      return;
    }

    this.logger.warn(
      {
        type: "key_package_quota",
        reason,
        clientPubkey: `${clientPubkey.slice(0, 12)}…`,
      },
      "cordn abuse protection rejection",
    );
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

    this.enforceKeyPackageQuota(stablePubkey, keyPackage);

    const record = this.coordinator.publishKeyPackage({
      stablePubkey,
      keyPackageRef: input.kp_ref,
      keyPackage,
      publicationEvent,
    });

    this.recordOperation("publishKeyPackage");

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
    // no extra available here; enforced in registration wrapper
    const record = this.coordinator.consumeKeyPackage(input.id);

    this.recordOperation("consumeKeyPackage");

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
    // no extra available here; enforced in registration wrapper
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

    this.recordOperation("removeKeyPackages");

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
    // no extra available here; enforced in registration wrapper
    const record = this.coordinator.storeWelcome({
      targetStablePubkey: input.target_pk,
      keyPackageReference: input.kp_ref,
      welcome: decodeWelcomeBase64(input.welcome_64),
    });

    this.recordOperation("storeWelcome");

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
    const clientPubkey = requireClientPubkey(extra);

    try {
      const record = this.coordinator.postGroupMessage({
        ephemeralSenderPubkey: clientPubkey,
        opaqueMessage: decodeOpaqueMessageBase64(input.msg_64),
      });

      this.recordOperation("postGroupMessage");

      return {
        content: [],
        structuredContent: {
          cursor: record.cursor,
          gid: record.groupId,
          at: record.createdAt,
        },
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Rejected stale handshake")
      ) {
        this.logger.warn(
          {
            type: "stale_handshake",
            clientPubkey: `${clientPubkey.slice(0, 12)}…`,
            error: error.message,
          },
          "stale handshake rejected",
        );
      }

      throw error;
    }
  }

  fetchGroupMessages(input: z.infer<typeof fetchGroupMessagesInputSchema>) {
    // no extra available here; enforced in registration wrapper
    const records = this.coordinator.fetchGroupMessages({
      groupId: input.gid,
      afterCursor: input.after,
    });

    this.recordOperation("fetchGroupMessages");

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
    const clientPubkey = extra._meta?.clientPubkey;
    const groupId = input.gid;

    const subscription = this.coordinator.subscribeGroupMessages({
      groupId,
      afterCursor: input.after,
    });
    const backlog = this.coordinator.fetchGroupMessages({
      groupId,
      afterCursor: input.after,
    });
    let lastEmittedCursor = input.after ?? 0;
    const originalAbort = stream.abort.bind(stream);
    const clientPubkeyLabel =
      typeof clientPubkey === "string" && clientPubkey.length > 0
        ? `${clientPubkey.slice(0, 12)}…`
        : undefined;
    let cleanedUp = false;
    let endLogged = false;

    this.logger.info(
      {
        type: "subscription_start",
        groupId,
        activeSubscriptions: this.coordinator.getActiveSubscriptionCount(),
        clientPubkey: clientPubkeyLabel,
      },
      "group message subscription started",
    );

    const cleanupSubscription = (reason: string): void => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      subscription.unsubscribe();

      if (endLogged) {
        return;
      }

      endLogged = true;
      this.logger.info(
        {
          type: "subscription_end",
          groupId,
          reason,
          activeSubscriptions: this.coordinator.getActiveSubscriptionCount(),
          clientPubkey: clientPubkeyLabel,
        },
        "group message subscription ended",
      );
    };

    stream.abort = async (reason?: string): Promise<void> => {
      cleanupSubscription(reason ?? "abort");
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
      cleanupSubscription("complete");
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
      cleanupSubscription("finally");
    }

    this.recordOperation("subscribeGroupMessages");

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
  const withRateLimit = <TInput, TOutput>(
    methodName: string,
    handler: (input: TInput, extra: ToolExtra) => TOutput | Promise<TOutput>,
  ) => {
    return (input: TInput, extra: ToolExtra) => {
      (
        adapter as CoordinatorAdapter & {
          assertWithinRateLimit(extra: ToolExtra, methodName: string): void;
        }
      ).assertWithinRateLimit(extra, methodName);
      return handler(input, extra);
    };
  };

  // TODO: Store the entire key package publish event
  server.registerTool(
    COORDINATOR_METHODS.publishKeyPackage,
    {
      description:
        "Publish an MLS key package for the injected caller identity.",
      inputSchema: publishKeyPackageInputSchema,
      outputSchema: publishKeyPackageOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.publishKeyPackage, (input, extra) =>
      adapter.publishKeyPackage(input, extra),
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.listAvailableKeyPackages,
    {
      description:
        "List currently available published MLS key packages discoverable on the coordinator.",
      inputSchema: listAvailableKeyPackagesInputSchema,
      outputSchema: listAvailableKeyPackagesOutputSchema,
    },
    withRateLimit(
      COORDINATOR_METHODS.listAvailableKeyPackages,
      (input, extra) => {
        void extra;
        return adapter.listAvailableKeyPackages(input);
      },
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.removeKeyPackages,
    {
      description:
        "Remove published MLS key packages owned by the injected caller identity.",
      inputSchema: removeKeyPackagesInputSchema,
      outputSchema: removeKeyPackagesOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.removeKeyPackages, (input, extra) =>
      adapter.removeKeyPackages(input, extra),
    ),
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
    withRateLimit(COORDINATOR_METHODS.consumeKeyPackage, (input, extra) => {
      void extra;
      return adapter.consumeKeyPackage(input);
    }),
  );

  server.registerTool(
    COORDINATOR_METHODS.fetchPendingWelcomes,
    {
      description:
        "Fetch and drain welcomes queued for the injected caller identity.",
      inputSchema: fetchPendingWelcomesInputSchema,
      outputSchema: fetchPendingWelcomesOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.fetchPendingWelcomes, (input, extra) =>
      adapter.fetchPendingWelcomes(input, extra),
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.storeWelcome,
    {
      description: "Store an MLS welcome for a target stable identity.",
      inputSchema: storeWelcomeInputSchema,
      outputSchema: storeWelcomeOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.storeWelcome, (input, extra) => {
      void extra;
      return adapter.storeWelcome(input);
    }),
  );

  server.registerTool(
    COORDINATOR_METHODS.postGroupMessage,
    {
      description:
        "Queue an MLS opaque group message for the injected caller identity.",
      inputSchema: postGroupMessageInputSchema,
      outputSchema: postGroupMessageOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.postGroupMessage, (input, extra) =>
      adapter.postGroupMessage(input, extra),
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.fetchGroupMessages,
    {
      description:
        "Fetch queued MLS opaque group messages by group and optional cursor.",
      inputSchema: fetchGroupMessagesInputSchema,
      outputSchema: fetchGroupMessagesOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.fetchGroupMessages, (input, extra) => {
      void extra;
      return adapter.fetchGroupMessages(input);
    }),
  );

  server.registerTool(
    COORDINATOR_METHODS.subscribeGroupMessages,
    {
      description:
        "Replay and stream MLS opaque group messages by group and optional cursor.",
      inputSchema: subscribeGroupMessagesInputSchema,
      outputSchema: subscribeGroupMessagesOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.subscribeGroupMessages, (input, extra) =>
      adapter.subscribeGroupMessages(input, extra),
    ),
  );
}
