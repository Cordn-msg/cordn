import { Client } from "@modelcontextprotocol/sdk/client";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
  type FetchGroupMessagesInput,
  fetchManyGroupMessagesOutputSchema,
  fetchManyPendingJoinRequestsOutputSchema,
  fetchGroupMessagesOutputSchema,
  fetchPendingJoinRequestsOutputSchema,
  fetchPendingWelcomesOutputSchema,
  listAvailableKeyPackagesOutputSchema,
  type PostGroupMessageInput,
  postGroupMessageOutputSchema,
  type PublishKeyPackageInput,
  publishKeyPackageOutputSchema,
  storeJoinRequestOutputSchema,
  storeWelcomeOutputSchema,
  subscribeManyGroupMessagesOutputSchema,
  subscribeGroupMessagesOutputSchema,
  type ConsumeKeyPackageOutput,
  type FetchGroupMessagesOutput,
  type FetchManyGroupMessagesOutput,
  type FetchManyPendingJoinRequestsOutput,
  type FetchPendingJoinRequestsInput,
  type FetchPendingJoinRequestsOutput,
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
  type SubscribeGroupMessagesInput,
  type SubscribeGroupMessagesOutput,
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
  FetchPendingJoinRequests: (
    input: FetchPendingJoinRequestsInput,
  ) => Promise<FetchPendingJoinRequestsOutput>;
  FetchManyPendingJoinRequests: (
    input: FetchManyPendingJoinRequestsInput,
  ) => Promise<FetchManyPendingJoinRequestsOutput>;
  PostGroupMessage: (
    input: PostGroupMessageInput,
  ) => Promise<PostGroupMessageOutput>;
  FetchGroupMessages: (
    input: FetchGroupMessagesInput,
  ) => Promise<FetchGroupMessagesOutput>;
  FetchManyGroupMessages: (
    input: FetchManyGroupMessagesInput,
  ) => Promise<FetchManyGroupMessagesOutput>;
  SubscribeGroupMessages: (input: SubscribeGroupMessagesInput) => Promise<{
    stream: AsyncIterable<GroupMessage>;
    result: Promise<SubscribeGroupMessagesOutput>;
    abort: (reason?: string) => Promise<void>;
  }>;
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
    const result = await client.callTool({
      name,
      arguments: { ...args },
    });
    return schema
      ? schema.parse(result.structuredContent)
      : (result.structuredContent as T);
  }

  /**
   * Publish an MLS key package for the injected caller identity.
   * @param {string} kp_ref The key package ref parameter
   * @param {string} kp_64 The key package base64 parameter
   * @returns {Promise<PublishKeyPackageOutput>} The result of the kp_publish operation
   */
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

  /**
   * Consume the next published MLS key package by stable identity or exact key package ref.
   * @param {string} id The stable pubkey or key package ref parameter
   * @returns {Promise<ConsumeKeyPackageOutput>} The result of the kp_take operation
   */
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

  /**
   * List currently available published MLS key packages discoverable on the coordinator.
   * @returns {Promise<ListAvailableKeyPackagesOutput>} The result of the kp_list operation
   */
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

  /**
   * Fetch pending welcomes queued for the injected caller identity.
   * @returns {Promise<FetchPendingWelcomesOutput>} The result of the fetchPendingWelcomes operation
   */
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

  /**
   * Store an MLS welcome for a target stable identity.
   * @param {string} target_pk The target stable pubkey parameter
   * @param {string} kp_ref The key package reference parameter
   * @param {string} welcome_64 The welcome base64 parameter
   * @returns {Promise<StoreWelcomeOutput>} The result of the welcome_store operation
   */
  async StoreWelcome(input: StoreWelcomeInput): Promise<StoreWelcomeOutput> {
    return this.call(
      "ephemeral",
      COORDINATOR_METHODS.storeWelcome,
      input,
      storeWelcomeOutputSchema,
    );
  }

  /**
   * Store a join request for a group, keyed by the requester's injected caller identity.
   * @param {string} gid The group id parameter
   * @param {string} kp_ref The key package reference parameter
   * @returns {Promise<StoreJoinRequestOutput>} The result of the join_request_store operation
   */
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

  /**
   * Fetch pending join requests for a group.
   * @param {string} gid The group id parameter
   * @returns {Promise<FetchPendingJoinRequestsOutput>} The result of the join_request_take operation
   */
  async FetchPendingJoinRequests(
    input: FetchPendingJoinRequestsInput,
  ): Promise<FetchPendingJoinRequestsOutput> {
    return this.call(
      "ephemeral",
      COORDINATOR_METHODS.fetchPendingJoinRequests,
      input,
      fetchPendingJoinRequestsOutputSchema,
    );
  }

  /**
   * Fetch pending join requests for multiple groups in a single call.
   * @param groups The array of group input objects, each with a gid
   * @returns {Promise<FetchManyPendingJoinRequestsOutput>} The result of the join_request_take_many operation
   */
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

  /**
   * Queue an MLS opaque group message for the injected caller identity.
   * @param {string} msg_64 The opaque message base64 parameter
   * @returns {Promise<PostGroupMessageOutput>} The result of the msg_post operation
   */
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

  /**
   * Fetch queued MLS opaque group messages by group and optional cursor.
   * @param {string} gid The group id parameter
   * @param {number} after [optional] The after cursor parameter
   * @returns {Promise<FetchGroupMessagesOutput>} The result of the msg_fetch operation
   */
  async FetchGroupMessages(
    input: FetchGroupMessagesInput,
  ): Promise<FetchGroupMessagesOutput> {
    return this.call(
      "ephemeral",
      COORDINATOR_METHODS.fetchGroupMessages,
      input,
      fetchGroupMessagesOutputSchema,
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

  async SubscribeGroupMessages(input: SubscribeGroupMessagesInput): Promise<{
    stream: AsyncIterable<GroupMessage>;
    result: Promise<SubscribeGroupMessagesOutput>;
    abort: (reason?: string) => Promise<void>;
  }> {
    await this.ephemeralConnected;

    const call = await callToolStream<CallToolResult>({
      client: this.ephemeralClient,
      transport: this.ephemeralTransport,
      name: COORDINATOR_METHODS.subscribeGroupMessages,
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
        subscribeGroupMessagesOutputSchema.parse(result.structuredContent),
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

  async SubscribeManyGroupMessages(
    input: SubscribeManyGroupMessagesInput,
  ): Promise<{
    stream: AsyncIterable<GroupMessage>;
    result: Promise<SubscribeManyGroupMessagesOutput>;
    abort: (reason?: string) => Promise<void>;
  }> {
    await this.ephemeralConnected;

    const call = await callToolStream<CallToolResult>({
      client: this.ephemeralClient,
      transport: this.ephemeralTransport,
      name: COORDINATOR_METHODS.subscribeManyGroupMessages,
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
        subscribeManyGroupMessagesOutputSchema.parse(result.structuredContent),
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
