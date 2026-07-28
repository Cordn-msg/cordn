/**
 * Production transport over a coordinator's MCP/Nostr wire. A thin client over
 * `@contextvm/sdk` (two `Client`s — authed + ephemeral), mirroring the web
 * app's `cordnClient`: it encodes the SDK's domain types to the `@cordn/core`
 * base64 wire contract, calls the tool, and parses the output schema back.
 *
 * The authed/ephemeral routing invariant (#4) lives here — callers never pick a
 * channel. Reference: `reference/cordn-web/src/lib/services/coordinatorClient.ts`
 * and `packages/server/src/coordinatorMethods.ts`.
 */
import { Client } from "@contextvm/mcp-sdk/client";
import {
  ApplesauceRelayPool,
  callToolStream,
  EncryptionMode,
  NostrClientTransport,
  PrivateKeySigner,
  type NostrSigner,
  type RelayHandler,
} from "@contextvm/sdk";
import type { KeyPackage } from "ts-mls";
import type { NostrEvent } from "nostr-tools";
import {
  COORDINATOR_METHODS,
  consumeKeyPackageOutputSchema,
  decodeBase64,
  decodeKeyPackage,
  decodeWelcome,
  encodeBase64,
  encodeKeyPackage,
  encodeWelcome,
  fetchManyGroupMessagesOutputSchema,
  fetchManyPendingJoinRequestsOutputSchema,
  fetchPendingWelcomesOutputSchema,
  groupMessageSchema,
  postGroupMessageOutputSchema,
  publishKeyPackageOutputSchema,
  removeKeyPackagesOutputSchema,
  storeJoinRequestOutputSchema,
  storeWelcomeOutputSchema,
  type ConsumedJoinRequestRef,
  type ConsumedWelcomeRef,
} from "@cordn/core";

import type {
  CordnTransport,
  FetchGroupMessagesInput,
  GroupMessageStream,
  JoinRequestItem,
  PostGroupMessageInput,
  PublishKeyPackageInput,
  PublishedKeyPackage,
  StoreJoinRequestInput,
  StoreWelcomeInput,
  TransportGroupMessage,
  WelcomeQueueItem,
} from "../../transport.ts";

const METHOD = COORDINATOR_METHODS;

export interface ContextVmTransportOptions {
  /** Coordinator server pubkey (hex). */
  serverPubkey: string;
  /** Relay handler (e.g. `ApplesauceRelayPool(relays)`). Omit to build one from `relays`. */
  relayHandler?: RelayHandler;
  /** Relays; ignored if `relayHandler` is provided. */
  relays?: string[];
  /** Signed-channel signer (caller identity): a NostrSigner or hex privkey. */
  authedSigner: NostrSigner | string;
  /** Ephemeral-channel signer; defaults to a fresh random key. */
  ephemeralSigner?: NostrSigner | string;
  /** Defaults to DISABLED (cordn signs its own payloads). */
  encryptionMode?: EncryptionMode;
}

/** Recover the key-package bytes from a consumed record's publication event.
 *
 * The server stores the MCP request event (resolved via `requestEventId`); its
 * `content` is the JSON-RPC tool-call envelope, with `kp_64` under
 * `params.arguments`. Mirrors the web app's `readKeyPackageBase64FromPublicationEvent`. */
export function decodeKeyPackageFromPublicationEvent(
  event: NostrEvent,
): KeyPackage {
  const parsed = JSON.parse(event.content) as {
    params?: { arguments?: { kp_64?: string } };
  };
  const kp64 = parsed.params?.arguments?.kp_64;
  if (!kp64) {
    throw new Error("Missing kp_64 in publication event");
  }
  return decodeKeyPackage(decodeBase64(kp64));
}

function toTransportGroupMessage(wire: {
  cursor: number;
  gid: string;
  msg_64: string;
  at: number;
}): TransportGroupMessage {
  return {
    cursor: wire.cursor,
    groupId: wire.gid,
    opaqueMessage: decodeBase64(wire.msg_64),
    createdAt: wire.at,
  };
}

export class ContextVmTransport implements CordnTransport {
  private readonly authedClient: Client;
  private readonly ephemeralClient: Client;
  private readonly authedTransport: NostrClientTransport;
  private readonly ephemeralTransport: NostrClientTransport;
  private readonly authedConnected: Promise<void>;
  private readonly ephemeralConnected: Promise<void>;

  constructor(opts: ContextVmTransportOptions) {
    const encryptionMode = opts.encryptionMode ?? EncryptionMode.DISABLED;
    const relayHandler =
      opts.relayHandler ?? new ApplesauceRelayPool(opts.relays ?? []);
    const transportBase = {
      serverPubkey: opts.serverPubkey,
      relayHandler,
      isStateless: true,
      logLevel: "silent" as const,
      encryptionMode,
      openStream: { enabled: true },
      oversizedTransfer: { enabled: true },
    };

    this.authedClient = new Client({
      name: "cordn-sdk-authed",
      version: "1.0.0",
    });
    this.ephemeralClient = new Client({
      name: "cordn-sdk-ephemeral",
      version: "1.0.0",
    });
    this.authedTransport = new NostrClientTransport({
      ...transportBase,
      signer:
        typeof opts.authedSigner === "string"
          ? new PrivateKeySigner(opts.authedSigner)
          : opts.authedSigner,
    });
    this.ephemeralTransport = new NostrClientTransport({
      ...transportBase,
      signer:
        opts.ephemeralSigner === undefined ||
        typeof opts.ephemeralSigner === "string"
          ? new PrivateKeySigner(opts.ephemeralSigner ?? undefined)
          : opts.ephemeralSigner,
    });
    this.authedConnected = this.authedClient.connect(this.authedTransport);
    this.ephemeralConnected = this.ephemeralClient.connect(
      this.ephemeralTransport,
    );
  }

  async disconnect(): Promise<void> {
    await Promise.all([
      this.authedConnected.catch(() => undefined),
      this.ephemeralConnected.catch(() => undefined),
    ]);
    await Promise.all([
      this.authedTransport.close().catch(() => undefined),
      this.ephemeralTransport.close().catch(() => undefined),
    ]);
  }

  private async call<T>(
    channel: "authed" | "ephemeral",
    method: string,
    args: Record<string, unknown>,
    schema?: { parse(data: unknown): T },
  ): Promise<T> {
    const client =
      channel === "authed" ? this.authedClient : this.ephemeralClient;
    await (channel === "authed"
      ? this.authedConnected
      : this.ephemeralConnected);
    // progress token engages CEP-22 oversized transfer for large catch-up payloads;
    // resetTimeoutOnProgress keeps the request alive while chunks are in flight.
    const result = await client.callTool(
      { name: method, arguments: { ...args } },
      undefined,
      { onprogress: () => undefined, resetTimeoutOnProgress: true },
    );
    if (result.isError) {
      const content = result.content as
        | Array<{ type: string; text?: string }>
        | undefined;
      throw new Error(
        content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n") || "Unknown coordinator error",
      );
    }
    return (
      schema
        ? schema.parse(result.structuredContent)
        : (result.structuredContent as T)
    ) as T;
  }

  // --- key packages -------------------------------------------------------

  async publishKeyPackage(
    input: PublishKeyPackageInput,
  ): Promise<PublishedKeyPackage> {
    const out = await this.call(
      "authed",
      METHOD.publishKeyPackage,
      {
        kp_ref: input.keyPackageRef,
        kp_64: encodeBase64(encodeKeyPackage(input.keyPackage)),
      },
      publishKeyPackageOutputSchema,
    );
    return {
      stablePubkey: input.stablePubkey,
      keyPackage: input.keyPackage,
      keyPackageRef: out.kp_ref,
      isLastResort: out.last_resort,
      publishedAt: out.at,
      publicationEvent: input.publicationEvent,
    };
  }

  async consumeKeyPackage(
    keyPackageRef: string,
  ): Promise<PublishedKeyPackage | null> {
    const out = await this.call(
      "ephemeral",
      METHOD.consumeKeyPackage,
      { id: keyPackageRef },
      consumeKeyPackageOutputSchema,
    );
    if (!out.keyPackage) {
      return null;
    }
    const record = out.keyPackage;
    return {
      stablePubkey: record.pk,
      keyPackage: decodeKeyPackageFromPublicationEvent(record.event),
      keyPackageRef: record.kp_ref,
      isLastResort: record.last_resort,
      publishedAt: record.at,
      publicationEvent: record.event,
    };
  }

  async removeKeyPackage(
    keyPackageRef: string,
  ): Promise<PublishedKeyPackage | null> {
    // Wire returns only the removed refs; the full record isn't recoverable and
    // no SDK consumer reads the return (KeyPackageManager.remove → void).
    await this.call(
      "authed",
      METHOD.removeKeyPackages,
      { kp_refs: [keyPackageRef] },
      removeKeyPackagesOutputSchema,
    );
    return null;
  }

  async listKeyPackages(_stablePubkey: string): Promise<PublishedKeyPackage[]> {
    // `kp_list` is metadata-only (no kp_64 / event), so a full PublishedKeyPackage
    // can't be reconstructed. Discover → consume() for a usable KeyPackage.
    throw new Error(
      "listKeyPackages is unavailable over the wire: the kp_list response is metadata-only. Use consume().",
    );
  }

  // --- welcomes -----------------------------------------------------------

  async storeWelcome(input: StoreWelcomeInput): Promise<WelcomeQueueItem> {
    const out = await this.call(
      "ephemeral",
      METHOD.storeWelcome,
      {
        target_pk: input.targetStablePubkey,
        kp_ref: input.keyPackageReference,
        welcome_64: encodeBase64(encodeWelcome(input.welcome)),
        ...(input.joinAfterCursor !== undefined
          ? { after: input.joinAfterCursor }
          : {}),
      },
      storeWelcomeOutputSchema,
    );
    return {
      targetStablePubkey: input.targetStablePubkey,
      keyPackageReference: input.keyPackageReference,
      welcome: input.welcome,
      createdAt: out.at,
      ...(input.joinAfterCursor !== undefined
        ? { joinAfterCursor: input.joinAfterCursor }
        : {}),
    };
  }

  async fetchPendingWelcomes(
    targetStablePubkey: string,
    consumed?: ConsumedWelcomeRef[],
  ): Promise<WelcomeQueueItem[]> {
    // Over the wire the target is the injected caller identity.
    const out = await this.call(
      "authed",
      METHOD.fetchPendingWelcomes,
      consumed && consumed.length > 0
        ? {
            consumed: consumed.map((c) => ({
              kp_ref: c.keyPackageReference,
              at: c.createdAt,
            })),
          }
        : {},
      fetchPendingWelcomesOutputSchema,
    );
    return out.welcomes.map((w) => ({
      targetStablePubkey,
      keyPackageReference: w.kp_ref,
      welcome: decodeWelcome(decodeBase64(w.welcome_64)),
      createdAt: w.at,
      ...(w.after !== undefined ? { joinAfterCursor: w.after } : {}),
    }));
  }

  // --- join requests ------------------------------------------------------

  async storeJoinRequest(
    input: StoreJoinRequestInput,
  ): Promise<JoinRequestItem> {
    const out = await this.call(
      "authed",
      METHOD.storeJoinRequest,
      { gid: input.groupId, kp_ref: input.keyPackageRef },
      storeJoinRequestOutputSchema,
    );
    return {
      groupId: input.groupId,
      requesterStablePubkey: input.requesterStablePubkey,
      keyPackageRef: input.keyPackageRef,
      createdAt: out.at,
    };
  }

  async fetchPendingJoinRequests(
    groupId: string,
    consumed?: ConsumedJoinRequestRef[],
  ): Promise<JoinRequestItem[]> {
    const out = await this.call(
      "ephemeral",
      METHOD.fetchManyPendingJoinRequests,
      {
        groups: [{ gid: groupId }],
        ...(consumed && consumed.length > 0
          ? {
              consumed: consumed.map((c) => ({
                gid: groupId,
                pk: c.requesterStablePubkey,
                at: c.createdAt,
              })),
            }
          : {}),
      },
      fetchManyPendingJoinRequestsOutputSchema,
    );
    return out.requests.map((r) => ({
      groupId: r.gid,
      requesterStablePubkey: r.pk,
      keyPackageRef: r.kp_ref,
      createdAt: r.at,
    }));
  }

  // --- group messages -----------------------------------------------------

  async postGroupMessage(
    input: PostGroupMessageInput,
  ): Promise<TransportGroupMessage> {
    const out = await this.call(
      "ephemeral",
      METHOD.postGroupMessage,
      { gid: input.groupId, msg_64: encodeBase64(input.opaqueMessage) },
      postGroupMessageOutputSchema,
    );
    return {
      cursor: out.cursor,
      groupId: out.gid,
      opaqueMessage: input.opaqueMessage,
      createdAt: out.at,
    };
  }

  async fetchGroupMessages(
    input: FetchGroupMessagesInput,
  ): Promise<TransportGroupMessage[]> {
    const out = await this.call(
      "ephemeral",
      METHOD.fetchManyGroupMessages,
      {
        groups: [
          {
            gid: input.groupId,
            ...(input.afterCursor !== undefined
              ? { after: input.afterCursor }
              : {}),
          },
        ],
      },
      fetchManyGroupMessagesOutputSchema,
    );
    return out.messages.map(toTransportGroupMessage);
  }

  async subscribeGroupMessages(
    input: FetchGroupMessagesInput,
  ): Promise<GroupMessageStream> {
    await this.ephemeralConnected;
    const call = await callToolStream({
      client: this.ephemeralClient,
      transport: this.ephemeralTransport,
      name: METHOD.subscribeManyGroupMessages,
      arguments: {
        groups: [
          {
            gid: input.groupId,
            ...(input.afterCursor !== undefined
              ? { after: input.afterCursor }
              : {}),
          },
        ],
      },
    });
    void call.stream.closed.catch(() => undefined);
    return {
      messages: {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of call.stream) {
            yield toTransportGroupMessage(
              groupMessageSchema.parse(
                JSON.parse((chunk as { value: string }).value),
              ),
            );
          }
        },
      },
      unsubscribe: async () => {
        try {
          await call.abort();
        } catch {
          // stream already gone
        }
      },
    };
  }
}
