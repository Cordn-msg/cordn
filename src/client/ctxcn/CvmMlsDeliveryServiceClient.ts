import { Client } from "@modelcontextprotocol/sdk/client";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  NostrClientTransport,
  type NostrTransportOptions,
  PrivateKeySigner,
  ApplesauceRelayPool,
} from "@contextvm/sdk";
import type { ZodType } from "zod";
import {
  type ConsumeKeyPackageForIdentityInput,
  consumeKeyPackageForIdentityOutputSchema,
  CONTEXTVM_COORDINATOR_TOOLS,
  type FetchGroupMessagesInput,
  fetchGroupMessagesOutputSchema,
  fetchPendingWelcomesOutputSchema,
  listAvailableKeyPackagesOutputSchema,
  type PostGroupMessageInput,
  postGroupMessageOutputSchema,
  type PublishKeyPackageInput,
  publishKeyPackageOutputSchema,
  storeWelcomeOutputSchema,
  type ConsumeKeyPackageForIdentityOutput,
  type FetchGroupMessagesOutput,
  type FetchPendingWelcomesInput,
  type FetchPendingWelcomesOutput,
  type ListAvailableKeyPackagesInput,
  type ListAvailableKeyPackagesOutput,
  type PostGroupMessageOutput,
  type PublishKeyPackageOutput,
  type StoreWelcomeInput,
  type StoreWelcomeOutput,
} from "../../contracts/contextvmCoordinator.ts";

export type CvmMlsDeliveryService = {
  PublishKeyPackage: (
    input: PublishKeyPackageInput,
  ) => Promise<PublishKeyPackageOutput>;
  ListAvailableKeyPackages: (
    args: ListAvailableKeyPackagesInput,
  ) => Promise<ListAvailableKeyPackagesOutput>;
  ConsumeKeyPackageForIdentity: (
    input: ConsumeKeyPackageForIdentityInput,
  ) => Promise<ConsumeKeyPackageForIdentityOutput>;
  FetchPendingWelcomes: (
    args: FetchPendingWelcomesInput,
  ) => Promise<FetchPendingWelcomesOutput>;
  StoreWelcome: (input: StoreWelcomeInput) => Promise<StoreWelcomeOutput>;
  PostGroupMessage: (
    input: PostGroupMessageInput,
  ) => Promise<PostGroupMessageOutput>;
  FetchGroupMessages: (
    input: FetchGroupMessagesInput,
  ) => Promise<FetchGroupMessagesOutput>;
};

export class CvmMlsDeliveryServiceClient implements CvmMlsDeliveryService {
  static readonly SERVER_PUBKEY =
    "22944dad40d5a314377d90f39d0f63cc54b6866777b8186a69c4921742d88399";
  static readonly DEFAULT_RELAYS = ["wss://relay.contextvm.org"];
  private client: Client;
  private transport: Transport;
  private readonly connected: Promise<void>;

  constructor(
    options: Partial<NostrTransportOptions> & {
      privateKey?: string;
      relays?: string[];
    } = {},
  ) {
    this.client = new Client({
      name: "CvmMlsDeliveryServiceClient",
      version: "1.0.0",
    });

    // Private key precedence: constructor options > config file
    const resolvedPrivateKey = options.privateKey || "";

    // Use options.signer if provided, otherwise create from resolved private key
    const signer = options.signer || new PrivateKeySigner(resolvedPrivateKey);
    // Use options.relays if provided, otherwise use class DEFAULT_RELAYS
    const relays = options.relays || CvmMlsDeliveryServiceClient.DEFAULT_RELAYS;
    // Use options.relayHandler if provided, otherwise create from relays
    const relayHandler =
      options.relayHandler || new ApplesauceRelayPool(relays);
    const serverPubkey =
      options.serverPubkey ?? CvmMlsDeliveryServiceClient.SERVER_PUBKEY;
    const { privateKey: _, serverPubkey: __, relays: ___, ...rest } = options;

    this.transport = new NostrClientTransport({
      serverPubkey,
      signer,
      relayHandler,
      isStateless: true,
      logLevel: "silent",
      ...rest,
    });

    // Auto-connect in constructor
    this.connected = this.client.connect(this.transport).catch((error) => {
      console.error(`Failed to connect to server: ${error}`);
      throw error;
    });
  }

  async disconnect(): Promise<void> {
    await this.connected.catch(() => undefined);
    await this.transport.close();
  }

  private async call<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    schema?: ZodType<T>,
  ): Promise<T> {
    await this.connected;
    const result = await this.client.callTool({
      name,
      arguments: { ...args },
    });
    return schema
      ? schema.parse(result.structuredContent)
      : (result.structuredContent as T);
  }

  /**
   * Publish an MLS key package for the injected caller identity.
   * @param {string} keyPackageRef The key package ref parameter
   * @param {string} keyPackageBase64 The key package base64 parameter
   * @returns {Promise<PublishKeyPackageOutput>} The result of the publish_key_package operation
   */
  async PublishKeyPackage(
    input: PublishKeyPackageInput,
  ): Promise<PublishKeyPackageOutput> {
    return this.call(
      CONTEXTVM_COORDINATOR_TOOLS.publishKeyPackage,
      input,
      publishKeyPackageOutputSchema,
    );
  }

  /**
   * Consume the next published MLS key package for a target stable identity.
   * @param {string} stablePubkey The stable pubkey parameter
   * @returns {Promise<ConsumeKeyPackageForIdentityOutput>} The result of the consume_key_package_for_identity operation
   */
  async ConsumeKeyPackageForIdentity(
    input: ConsumeKeyPackageForIdentityInput,
  ): Promise<ConsumeKeyPackageForIdentityOutput> {
    return this.call(
      CONTEXTVM_COORDINATOR_TOOLS.consumeKeyPackageForIdentity,
      input,
      consumeKeyPackageForIdentityOutputSchema,
    );
  }

  /**
   * List currently available published MLS key packages discoverable on the coordinator.
   * @returns {Promise<ListAvailableKeyPackagesOutput>} The result of the list_available_key_packages operation
   */
  async ListAvailableKeyPackages(
    args: ListAvailableKeyPackagesInput = {},
  ): Promise<ListAvailableKeyPackagesOutput> {
    return this.call(
      CONTEXTVM_COORDINATOR_TOOLS.listAvailableKeyPackages,
      args,
      listAvailableKeyPackagesOutputSchema,
    );
  }

  /**
   * Fetch and drain welcomes queued for the injected caller identity.
   * @returns {Promise<FetchPendingWelcomesOutput>} The result of the fetch_pending_welcomes operation
   */
  async FetchPendingWelcomes(
    args: FetchPendingWelcomesInput,
  ): Promise<FetchPendingWelcomesOutput> {
    return this.call(
      CONTEXTVM_COORDINATOR_TOOLS.fetchPendingWelcomes,
      args,
      fetchPendingWelcomesOutputSchema,
    );
  }

  /**
   * Store an MLS welcome for a target stable identity.
   * @param {string} targetStablePubkey The target stable pubkey parameter
   * @param {string} keyPackageReference The key package reference parameter
   * @param {string} welcomeBase64 The welcome base64 parameter
   * @returns {Promise<StoreWelcomeOutput>} The result of the store_welcome operation
   */
  async StoreWelcome(input: StoreWelcomeInput): Promise<StoreWelcomeOutput> {
    return this.call(
      CONTEXTVM_COORDINATOR_TOOLS.storeWelcome,
      input,
      storeWelcomeOutputSchema,
    );
  }

  /**
   * Queue an MLS opaque group message for the injected caller identity.
   * @param {string} opaqueMessageBase64 The opaque message base64 parameter
   * @returns {Promise<PostGroupMessageOutput>} The result of the post_group_message operation
   */
  async PostGroupMessage(
    input: PostGroupMessageInput,
  ): Promise<PostGroupMessageOutput> {
    return this.call(
      CONTEXTVM_COORDINATOR_TOOLS.postGroupMessage,
      input,
      postGroupMessageOutputSchema,
    );
  }

  /**
   * Fetch queued MLS opaque group messages by group and optional cursor.
   * @param {string} groupId The group id parameter
   * @param {number} afterCursor [optional] The after cursor parameter
   * @returns {Promise<FetchGroupMessagesOutput>} The result of the fetch_group_messages operation
   */
  async FetchGroupMessages(
    input: FetchGroupMessagesInput,
  ): Promise<FetchGroupMessagesOutput> {
    return this.call(
      CONTEXTVM_COORDINATOR_TOOLS.fetchGroupMessages,
      input,
      fetchGroupMessagesOutputSchema,
    );
  }
}
