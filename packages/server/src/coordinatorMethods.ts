import { McpServer } from "@contextvm/mcp-sdk/server/mcp";
import type { OpenStreamWriter } from "@contextvm/sdk/transport";
import type { RequestHandlerExtra } from "@contextvm/mcp-sdk/shared/protocol";
import type {
  ServerNotification,
  ServerRequest,
} from "@contextvm/mcp-sdk/types.js";
import type { NostrEvent } from "nostr-tools";
import type { z } from "zod";
import {
  isDefaultCredential,
  keyPackageDecoder,
  type KeyPackage,
  type Welcome,
} from "ts-mls";

import { isLastResortKeyPackage } from "@cordn/core";
import type { GroupMessageRecord } from "@cordn/coordinator";
import { Coordinator } from "@cordn/coordinator";
import {
  consumeKeyPackageInputSchema,
  consumeKeyPackageOutputSchema,
  COORDINATOR_METHODS,
  fetchManyGroupMessagesInputSchema,
  fetchManyGroupMessagesOutputSchema,
  fetchManyPendingJoinRequestsInputSchema,
  fetchManyPendingJoinRequestsOutputSchema,
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
  storeJoinRequestInputSchema,
  storeJoinRequestOutputSchema,
  storeWelcomeInputSchema,
  storeWelcomeOutputSchema,
  subscribeManyGroupMessagesInputSchema,
  subscribeManyGroupMessagesOutputSchema,
} from "@cordn/core";
import { decodeExact, decodeWelcome, encodeWelcome } from "@cordn/core";
import { assertNonEmptyBase64, encodeBase64 } from "@cordn/core";
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
  // Signature already verified upstream by the SDK's ServerEventPipeline
  // (the identity-forgery fix); re-running schnorr here is redundant work.
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

/** Maps a GroupMessageRecord to the wire format. */
function mapGroupMessage(
  record: Pick<
    GroupMessageRecord,
    "cursor" | "groupId" | "opaqueMessage" | "createdAt"
  >,
): z.infer<typeof groupMessageSchema> {
  return {
    cursor: record.cursor,
    gid: record.groupId,
    msg_64: encodeBase64(record.opaqueMessage),
    at: record.createdAt,
  };
}

// Live messages fan out to every subscribed client; the coordinator pushes the
// same record reference into each subscriber's queue. Cache the wire string per
// record so base64 + JSON.stringify run once per message, not once per
// subscriber. Backlog fetches return fresh objects per client and miss this
// cache by design -- only live fanout benefits.
// ponytail: WeakMap so entries GC with the record once queues drain; bounded by
// in-flight messages, not message history.
const wireMessageByRecord = new WeakMap<GroupMessageRecord, string>();

function encodeWireMessage(record: GroupMessageRecord): string {
  const cached = wireMessageByRecord.get(record);
  if (cached !== undefined) {
    return cached;
  }

  const encoded = JSON.stringify(mapGroupMessage(record));
  wireMessageByRecord.set(record, encoded);
  return encoded;
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

  close(): void {
    this.coordinator.close();
  }

  private recordOperation(methodName: string): void {
    const count = (this.metrics.get(methodName) ?? 0) + 1;
    this.metrics.set(methodName, count);
    this.logger.debug(
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
    input: z.infer<typeof fetchPendingWelcomesInputSchema>,
    extra: ToolExtra,
  ) {
    const records = this.coordinator.fetchPendingWelcomes(
      requireClientPubkey(extra),
      input.consumed?.map((c) => ({
        keyPackageReference: c.kp_ref,
        createdAt: c.at,
      })),
    );

    return {
      content: [],
      structuredContent: {
        welcomes: records.map((record) => ({
          kp_ref: record.keyPackageReference,
          welcome_64: encodeWelcomeBase64(record.welcome),
          at: record.createdAt,
          after: record.joinAfterCursor,
          sender_pk: record.senderStablePubkey,
        })),
      },
    };
  }

  storeWelcome(
    input: z.infer<typeof storeWelcomeInputSchema>,
    extra: ToolExtra,
  ) {
    const record = this.coordinator.storeWelcome({
      targetStablePubkey: input.target_pk,
      senderStablePubkey: requireClientPubkey(extra),
      keyPackageReference: input.kp_ref,
      welcome: decodeWelcomeBase64(input.welcome_64),
      joinAfterCursor: input.after,
    });

    this.recordOperation("storeWelcome");

    return {
      content: [],
      structuredContent: {
        at: record.createdAt,
      },
    };
  }

  storeJoinRequest(
    input: z.infer<typeof storeJoinRequestInputSchema>,
    extra: ToolExtra,
  ) {
    const clientPubkey = requireClientPubkey(extra);

    const keyPackageRecord = this.coordinator.getKeyPackage(input.kp_ref);
    if (!keyPackageRecord) {
      throw new Error("Unknown key package ref");
    }

    if (keyPackageRecord.stablePubkey !== clientPubkey) {
      throw new Error("Unauthorized key package ref");
    }

    const record = this.coordinator.storeJoinRequest({
      groupId: input.gid,
      requesterStablePubkey: clientPubkey,
      keyPackageRef: input.kp_ref,
    });

    this.recordOperation("storeJoinRequest");

    return {
      content: [],
      structuredContent: {
        at: record.createdAt,
      },
    };
  }

  fetchManyPendingJoinRequests(
    input: z.infer<typeof fetchManyPendingJoinRequestsInputSchema>,
  ) {
    // no extra available here; enforced in registration wrapper
    const records = this.coordinator.fetchManyPendingJoinRequests({
      groups: input.groups.map((group) => ({ groupId: group.gid })),
      consumed: input.consumed?.map((c) => ({
        groupId: c.gid,
        requesterStablePubkey: c.pk,
        createdAt: c.at,
      })),
    });

    this.recordOperation("fetchManyPendingJoinRequests");

    return {
      content: [],
      structuredContent: {
        requests: records.map((record) => ({
          gid: record.groupId,
          pk: record.requesterStablePubkey,
          kp_ref: record.keyPackageRef,
          at: record.createdAt,
        })),
      },
    };
  }

  postGroupMessage(input: z.infer<typeof postGroupMessageInputSchema>) {
    const record = this.coordinator.postGroupMessage({
      opaqueMessage: decodeOpaqueMessageBase64(input.msg_64),
      groupId: input.gid,
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
  }

  fetchManyGroupMessages(
    input: z.infer<typeof fetchManyGroupMessagesInputSchema>,
  ) {
    const records = this.coordinator.fetchManyGroupMessages({
      groups: input.groups.map((group) => ({
        groupId: group.gid,
        afterCursor: group.after,
      })),
    });

    this.recordOperation("fetchManyGroupMessages");

    return {
      content: [],
      structuredContent: {
        messages: records.map(mapGroupMessage),
      },
    };
  }

  async subscribeManyGroupMessages(
    input: z.infer<typeof subscribeManyGroupMessagesInputSchema>,
    extra: ToolExtra,
  ) {
    const stream = getOpenStreamWriter(extra);
    const clientPubkey = extra._meta?.clientPubkey;
    const clientPubkeyLabel =
      typeof clientPubkey === "string" && clientPubkey.length > 0
        ? `${clientPubkey.slice(0, 12)}…`
        : undefined;
    const subscription = this.coordinator.subscribeManyGroupMessages({
      groups: input.groups.map((group) => ({
        groupId: group.gid,
        afterCursor: group.after,
      })),
    });
    const originalAbort = stream.abort.bind(stream);
    let cleanedUp = false;
    let endLogged = false;

    this.logger.info(
      {
        type: "subscription_start",
        groupIds: input.groups.map((group) => group.gid),
        groupCount: input.groups.length,
        activeSubscriptions: this.coordinator.getActiveSubscriptionCount(),
        clientPubkey: clientPubkeyLabel,
      },
      "multi-group message subscription started",
    );

    const cleanupSubscriptions = (reason: string): void => {
      if (!cleanedUp) {
        cleanedUp = true;
        subscription.unsubscribe();
      }

      if (endLogged) {
        return;
      }

      endLogged = true;
      this.logger.info(
        {
          type: "subscription_end",
          groupIds: input.groups.map((group) => group.gid),
          groupCount: input.groups.length,
          reason,
          activeSubscriptions: this.coordinator.getActiveSubscriptionCount(),
          clientPubkey: clientPubkeyLabel,
        },
        "multi-group message subscription ended",
      );
    };

    stream.abort = async (reason?: string): Promise<void> => {
      cleanupSubscriptions(reason ?? "abort");
      await originalAbort(reason);
    };

    // ponytail: writer.signal (SDK 0.13.8+) fires on every termination incl.
    // dispose() (transport teardown), which the abort override above misses.
    // Idempotent; the override still wins for log reasons on abort paths.
    stream.signal.addEventListener(
      "abort",
      () => cleanupSubscriptions("client-disconnect"),
      { once: true },
    );

    try {
      await stream.start();

      for await (const record of subscription.messages) {
        if (!stream.isActive) {
          break;
        }

        await stream.write(encodeWireMessage(record));
      }

      cleanupSubscriptions("complete");
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
      cleanupSubscriptions("finally");
    }

    this.recordOperation("subscribeManyGroupMessages");

    return {
      content: [],
      structuredContent: {
        subscribed: true,
        groups: input.groups.map((group) => group.gid),
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
      adapter.assertWithinRateLimit(extra, methodName);
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
        "Fetch pending welcomes queued for the injected caller identity.",
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
      return adapter.storeWelcome(input, extra);
    }),
  );

  server.registerTool(
    COORDINATOR_METHODS.storeJoinRequest,
    {
      description:
        "Store a join request for a group from the injected caller identity.",
      inputSchema: storeJoinRequestInputSchema,
      outputSchema: storeJoinRequestOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.storeJoinRequest, (input, extra) =>
      adapter.storeJoinRequest(input, extra),
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.fetchManyPendingJoinRequests,
    {
      description:
        "Fetch pending join requests for multiple groups in a single call.",
      inputSchema: fetchManyPendingJoinRequestsInputSchema,
      outputSchema: fetchManyPendingJoinRequestsOutputSchema,
    },
    withRateLimit(
      COORDINATOR_METHODS.fetchManyPendingJoinRequests,
      (input, extra) => {
        void extra;
        return adapter.fetchManyPendingJoinRequests(input);
      },
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.postGroupMessage,
    {
      description:
        "Queue an MLS opaque group message for the injected caller identity.",
      inputSchema: postGroupMessageInputSchema,
      outputSchema: postGroupMessageOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.postGroupMessage, (input) =>
      adapter.postGroupMessage(input),
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.fetchManyGroupMessages,
    {
      description:
        "Fetch queued MLS opaque group messages for multiple groups with independent optional cursors.",
      inputSchema: fetchManyGroupMessagesInputSchema,
      outputSchema: fetchManyGroupMessagesOutputSchema,
    },
    withRateLimit(
      COORDINATOR_METHODS.fetchManyGroupMessages,
      (input, extra) => {
        void extra;
        return adapter.fetchManyGroupMessages(input);
      },
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.subscribeManyGroupMessages,
    {
      description:
        "Replay and stream MLS opaque group messages for multiple groups with independent optional cursors.",
      inputSchema: subscribeManyGroupMessagesInputSchema,
      outputSchema: subscribeManyGroupMessagesOutputSchema,
    },
    withRateLimit(
      COORDINATOR_METHODS.subscribeManyGroupMessages,
      (input, extra) => adapter.subscribeManyGroupMessages(input, extra),
    ),
  );
}
