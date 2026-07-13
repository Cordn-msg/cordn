import { Client } from "@contextvm/mcp-sdk/client";
import type { CallToolResult } from "@contextvm/mcp-sdk/types.js";
import {
  callToolStream,
  NostrClientTransport,
  type NostrTransportOptions,
  PrivateKeySigner,
  ApplesauceRelayPool,
  EncryptionMode,
} from "@contextvm/sdk";
import type { ZodType } from "zod";
import {
  type ConsumeKeyPackageInput,
  consumeKeyPackageOutputSchema,
  COORDINATOR_METHODS,
  type FetchManyGroupMessagesInput,
  type FetchManyPendingJoinRequestsInput,
  fetchManyGroupMessagesOutputSchema,
  fetchManyPendingJoinRequestsOutputSchema,
  fetchPendingWelcomesOutputSchema,
  listAvailableKeyPackagesOutputSchema,
  type PostGroupMessageInput,
  postGroupMessageOutputSchema,
  type PublishKeyPackageInput,
  publishKeyPackageOutputSchema,
  storeJoinRequestOutputSchema,
  storeWelcomeOutputSchema,
  subscribeManyGroupMessagesOutputSchema,
  type ConsumeKeyPackageOutput,
  type FetchManyGroupMessagesOutput,
  type FetchManyPendingJoinRequestsOutput,
  type FetchPendingWelcomesInput,
  type FetchPendingWelcomesOutput,
  type GroupMessage,
  type ListAvailableKeyPackagesInput,
  type ListAvailableKeyPackagesOutput,
  type PostGroupMessageOutput,
  type PublishKeyPackageOutput,
  type RemoveKeyPackagesInput,
  type RemoveKeyPackagesOutput,
  type StoreJoinRequestInput,
  type StoreJoinRequestOutput,
  type SubscribeManyGroupMessagesInput,
  type SubscribeManyGroupMessagesOutput,
  type StoreWelcomeInput,
  type StoreWelcomeOutput,
  groupMessageSchema,
  removeKeyPackagesOutputSchema,
} from "../contracts/index.ts";

export type coordinatorClient = {
  PublishKeyPackage: (
    input: PublishKeyPackageInput,
  ) => Promise<PublishKeyPackageOutput>;
  ListAvailableKeyPackages: (
    args: ListAvailableKeyPackagesInput,
  ) => Promise<ListAvailableKeyPackagesOutput>;
  ConsumeKeyPackage: (
    input: ConsumeKeyPackageInput,
  ) => Promise<ConsumeKeyPackageOutput>;
  RemoveKeyPackages: (
    input: RemoveKeyPackagesInput,
  ) => Promise<RemoveKeyPackagesOutput>;
  FetchPendingWelcomes: (
    args: FetchPendingWelcomesInput,
  ) => Promise<FetchPendingWelcomesOutput>;
  StoreWelcome: (input: StoreWelcomeInput) => Promise<StoreWelcomeOutput>;
  StoreJoinRequest: (
    input: StoreJoinRequestInput,
  ) => Promise<StoreJoinRequestOutput>;
  FetchManyPendingJoinRequests: (
    input: FetchManyPendingJoinRequestsInput,
  ) => Promise<FetchManyPendingJoinRequestsOutput>;
  PostGroupMessage: (
    input: PostGroupMessageInput,
  ) => Promise<PostGroupMessageOutput>;
  FetchManyGroupMessages: (
    input: FetchManyGroupMessagesInput,
  ) => Promise<FetchManyGroupMessagesOutput>;
  SubscribeManyGroupMessages: (
    input: SubscribeManyGroupMessagesInput,
  ) => Promise<{
    stream: AsyncIterable<GroupMessage>;
    result: Promise<SubscribeManyGroupMessagesOutput>;
    abort: (reason?: string) => Promise<void>;
  }>;
};

export class cordnClient implements coordinatorClient {
  static readonly DEFAULT_RELAYS = ["ws://localhost:10547"];
  // static readonly DEFAULT_RELAYS = ["wss://relay.contextvm.org"];
  private readonly stableClient: Client;
  private readonly stableTransport: NostrClientTransport;
  private readonly stableConnected: Promise<void>;
  private readonly ephemeralClient: Client;
  private readonly ephemeralTransport: NostrClientTransport;
  private readonly ephemeralConnected: Promise<void>;

  constructor(
    options: Partial<NostrTransportOptions> & {
      privateKey?: string;
      ephemeralPrivateKey?: string;
      relays?: string[];
    } = {},
  ) {
    this.stableClient = new Client({
      name: "CvmMlsDeliveryServiceClient",
      version: "1.0.0",
    });
    this.ephemeralClient = new Client({
      name: "CvmMlsDeliveryServiceClientEphemeral",
      version: "1.0.0",
    });

    // Private key precedence: constructor options > config file
    const resolvedPrivateKey = options.privateKey || "";
    const resolvedEphemeralPrivateKey = options.ephemeralPrivateKey;

    // Use options.relays if provided, otherwise use class DEFAULT_RELAYS
    const relays = options.relays || cordnClient.DEFAULT_RELAYS;
    // Use options.relayHandler if provided, otherwise create from relays
    const relayHandler =
      options.relayHandler || new ApplesauceRelayPool(relays);
    const serverPubkey = options.serverPubkey;
    if (!serverPubkey) {
      throw new Error(
        "Missing coordinator server pubkey. Pass serverPubkey explicitly or configure the CLI entrypoint to provide one.",
      );
    }
    const {
      privateKey: _,
      ephemeralPrivateKey: ____,
      serverPubkey: __,
      relays: ___,
      relayHandler: _____,
      signer: providedSigner,
      ...rest
    } = options;

    this.stableTransport = new NostrClientTransport({
      serverPubkey,
      signer: providedSigner || new PrivateKeySigner(resolvedPrivateKey),
      relayHandler,
      isStateless: true,
      logLevel: "silent",
      encryptionMode: EncryptionMode.DISABLED,
      openStream: {
        enabled: true,
      },
      oversizedTransfer: {
        enabled: true,
      },
      ...rest,
    });

    this.ephemeralTransport = new NostrClientTransport({
      serverPubkey,
      signer: resolvedEphemeralPrivateKey
        ? new PrivateKeySigner(resolvedEphemeralPrivateKey)
        : new PrivateKeySigner(),
      relayHandler,
      isStateless: true,
      logLevel: "silent",
      encryptionMode: EncryptionMode.DISABLED,
      openStream: {
        enabled: true,
      },
      oversizedTransfer: {
        enabled: true,
      },
      ...rest,
    });

    // Auto-connect in constructor
    this.stableConnected = this.stableClient
      .connect(this.stableTransport)
      .catch((error) => {
        console.error(`Failed to connect stable client to server: ${error}`);
        throw error;
      });
    this.ephemeralConnected = this.ephemeralClient
      .connect(this.ephemeralTransport)
      .catch((error) => {
        console.error(`Failed to connect ephemeral client to server: ${error}`);
        throw error;
      });
  }

  async disconnect(): Promise<void> {
    await Promise.all([
      this.stableConnected.catch(() => undefined),
      this.ephemeralConnected.catch(() => undefined),
    ]);
    await Promise.all([
      this.stableTransport.close().catch(() => undefined),
      this.ephemeralTransport.close().catch(() => undefined),
    ]);
  }

  private async call<T = unknown>(
    transportKind: "stable" | "ephemeral",
    name: string,
    args: Record<string, unknown>,
    schema?: ZodType<T>,
  ): Promise<T> {
    const client =
      transportKind === "stable" ? this.stableClient : this.ephemeralClient;
    const connected =
      transportKind === "stable"
        ? this.stableConnected
        : this.ephemeralConnected;

    await connected;
    // Attach a progress callback so the request carries a progress token. This
    // is required for CEP-22 oversized transfer to engage when a response (e.g.
    // a large bounded catch-up payload) exceeds the ~48KB published-event
    // threshold. `resetTimeoutOnProgress` keeps the request alive while chunked
    // transfer frames are in flight.
    const result = await client.callTool(
      {
        name,
        arguments: { ...args },
      },
      undefined,
      {
        onprogress: () => undefined,
        resetTimeoutOnProgress: true,
      },
    );
    return schema
      ? schema.parse(result.structuredContent)
      : (result.structuredContent as T);
  }

  async PublishKeyPackage(
    input: PublishKeyPackageInput,
  ): Promise<PublishKeyPackageOutput> {
    return this.call(
      "stable",
      COORDINATOR_METHODS.publishKeyPackage,
      input,
      publishKeyPackageOutputSchema,
    );
  }

  async ConsumeKeyPackage(
    input: ConsumeKeyPackageInput,
  ): Promise<ConsumeKeyPackageOutput> {
    return this.call(
      "ephemeral",
      COORDINATOR_METHODS.consumeKeyPackage,
      input,
      consumeKeyPackageOutputSchema,
    );
  }

  async RemoveKeyPackages(
    input: RemoveKeyPackagesInput,
  ): Promise<RemoveKeyPackagesOutput> {
    return this.call(
      "stable",
      COORDINATOR_METHODS.removeKeyPackages,
      input,
      removeKeyPackagesOutputSchema,
    );
  }

  async ListAvailableKeyPackages(
    args: ListAvailableKeyPackagesInput = {},
  ): Promise<ListAvailableKeyPackagesOutput> {
    return this.call(
      "ephemeral",
      COORDINATOR_METHODS.listAvailableKeyPackages,
      args,
      listAvailableKeyPackagesOutputSchema,
    );
  }

  async FetchPendingWelcomes(
    args: FetchPendingWelcomesInput,
  ): Promise<FetchPendingWelcomesOutput> {
    return this.call(
      "stable",
      COORDINATOR_METHODS.fetchPendingWelcomes,
      args,
      fetchPendingWelcomesOutputSchema,
    );
  }

  async StoreWelcome(input: StoreWelcomeInput): Promise<StoreWelcomeOutput> {
    return this.call(
      "ephemeral",
      COORDINATOR_METHODS.storeWelcome,
      input,
      storeWelcomeOutputSchema,
    );
  }

  async StoreJoinRequest(
    input: StoreJoinRequestInput,
  ): Promise<StoreJoinRequestOutput> {
    return this.call(
      "stable",
      COORDINATOR_METHODS.storeJoinRequest,
      input,
      storeJoinRequestOutputSchema,
    );
  }

  async FetchManyPendingJoinRequests(
    input: FetchManyPendingJoinRequestsInput,
  ): Promise<FetchManyPendingJoinRequestsOutput> {
    return this.call(
      "ephemeral",
      COORDINATOR_METHODS.fetchManyPendingJoinRequests,
      input,
      fetchManyPendingJoinRequestsOutputSchema,
    );
  }

  async PostGroupMessage(
    input: PostGroupMessageInput,
  ): Promise<PostGroupMessageOutput> {
    return this.call(
      "ephemeral",
      COORDINATOR_METHODS.postGroupMessage,
      input,
      postGroupMessageOutputSchema,
    );
  }

  async FetchManyGroupMessages(
    input: FetchManyGroupMessagesInput,
  ): Promise<FetchManyGroupMessagesOutput> {
    return this.call(
      "ephemeral",
      COORDINATOR_METHODS.fetchManyGroupMessages,
      input,
      fetchManyGroupMessagesOutputSchema,
    );
  }

  async SubscribeManyGroupMessages(
    input: SubscribeManyGroupMessagesInput,
  ): Promise<{
    stream: AsyncIterable<GroupMessage>;
    result: Promise<SubscribeManyGroupMessagesOutput>;
    abort: (reason?: string) => Promise<void>;
  }> {
    return this.subscribe(
      COORDINATOR_METHODS.subscribeManyGroupMessages,
      input,
      subscribeManyGroupMessagesOutputSchema,
    );
  }

  private async subscribe<TOutput>(
    name: string,
    input: object,
    schema: ZodType<TOutput>,
  ): Promise<{
    stream: AsyncIterable<GroupMessage>;
    result: Promise<TOutput>;
    abort: (reason?: string) => Promise<void>;
  }> {
    await this.ephemeralConnected;

    const call = await callToolStream<CallToolResult>({
      client: this.ephemeralClient,
      transport: this.ephemeralTransport,
      name,
      arguments: { ...input },
    });
    void call.stream.closed.catch(() => undefined);

    const stream: AsyncIterable<GroupMessage> = {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of call.stream) {
          yield groupMessageSchema.parse(JSON.parse(chunk.value));
        }
      },
    };

    return {
      stream,
      result: call.result.then((result) =>
        schema.parse(result.structuredContent),
      ),
      abort: async (reason?: string) => {
        try {
          await call.abort(reason);
        } catch {
          return;
        }
      },
    };
  }
}
