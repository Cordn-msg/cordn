import { Client } from "@modelcontextprotocol/sdk/client";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  NostrClientTransport,
  type NostrTransportOptions,
  PrivateKeySigner,
  ApplesauceRelayPool,
} from "@contextvm/sdk";

export type BridgeInfoInput = Record<string, unknown>;

export interface BridgeInfoOutput {
  status: string;
  contract: string;
  bridge: string;
  database_path: string;
}

export interface RegisterClientInput {
  stable_identity: string;
  delivery_addresses: string[];
}

export interface RegisterClientOutput {
  registered: boolean;
}

export type ListClientsInput = Record<string, unknown>;

export interface ListClientsOutput {
  clients: {
    stable_identity: string;
    delivery_addresses: string[];
  }[];
}

export interface PublishKeyPackagesInput {
  stable_identity: string;
  key_packages: {
    key_package_ref: string;
    key_package: string;
  }[];
}

export interface PublishKeyPackagesOutput {
  published: number;
}

export interface GetKeyPackagesInput {
  stable_identity: string;
}

export interface GetKeyPackagesOutput {
  key_packages: {
    key_package_ref: string;
    key_package: string;
  }[];
}

export interface ConsumeKeyPackageInput {
  stable_identity: string;
}

export interface ConsumeKeyPackageOutput {
  key_package: {
    key_package_ref: string;
    key_package: string;
  };
}

export interface PutGroupRouteInput {
  group_id: string;
  epoch: number;
  members: string[];
}

export interface PutGroupRouteOutput {
  stored: boolean;
}

export interface SendWelcomeInput {
  stable_identity: string;
  key_package_ref: string;
  message_bytes: string;
}

export interface SendWelcomeOutput {
  stored: boolean;
}

export interface RecvWelcomesInput {
  stable_identity: string;
}

export interface RecvWelcomesOutput {
  welcomes: {
    stable_identity: string;
    key_package_ref: string;
    message_bytes: string;
  }[];
}

export interface SendMessageInput {
  group_id: string;
  epoch: number;
  sender: string;
  recipients: string[];
  message_bytes: string;
}

export interface SendMessageOutput {
  stored: boolean;
}

export interface RecvMessagesInput {
  delivery_address: string;
}

export interface RecvMessagesOutput {
  messages: {
    group_id: string;
    epoch: number;
    sender: string;
    recipients: string[];
    message_bytes: string;
  }[];
}

export type MlsDsCvm = {
  BridgeInfo: (args: BridgeInfoInput) => Promise<BridgeInfoOutput>;
  RegisterClient: (stable_identity: string, delivery_addresses: string[]) => Promise<RegisterClientOutput>;
  ListClients: (args: ListClientsInput) => Promise<ListClientsOutput>;
  PublishKeyPackages: (stable_identity: string, key_packages: object[]) => Promise<PublishKeyPackagesOutput>;
  GetKeyPackages: (stable_identity: string) => Promise<GetKeyPackagesOutput>;
  ConsumeKeyPackage: (stable_identity: string) => Promise<ConsumeKeyPackageOutput>;
  PutGroupRoute: (group_id: string, epoch: number, members: string[]) => Promise<PutGroupRouteOutput>;
  SendWelcome: (stable_identity: string, key_package_ref: string, message_bytes: string) => Promise<SendWelcomeOutput>;
  RecvWelcomes: (stable_identity: string) => Promise<RecvWelcomesOutput>;
  SendMessage: (group_id: string, epoch: number, sender: string, recipients: string[], message_bytes: string) => Promise<SendMessageOutput>;
  RecvMessages: (delivery_address: string) => Promise<RecvMessagesOutput>;
};

export class MlsDsCvmClient implements MlsDsCvm {
  static readonly SERVER_PUBKEY = "dcc005ba656ef7b70a12463d0a8abc733a733388900fd5b1ec1284f1fde2ea0f";
  static readonly DEFAULT_RELAYS = ["wss://relay.contextvm.org"];
  private client: Client;
  private transport: Transport;

  constructor(
    options: Partial<NostrTransportOptions> & { privateKey?: string; relays?: string[] } = {}
  ) {
    this.client = new Client({
      name: "MlsDsCvmClient",
      version: "1.0.0",
    });

    // Private key precedence: constructor options > config file
    const resolvedPrivateKey = options.privateKey ||
      "";

    // Use options.signer if provided, otherwise create from resolved private key
    const signer = options.signer || new PrivateKeySigner(resolvedPrivateKey);
    // Use options.relays if provided, otherwise use class DEFAULT_RELAYS
    const relays = options.relays || MlsDsCvmClient.DEFAULT_RELAYS;
    // Use options.relayHandler if provided, otherwise create from relays
    const relayHandler = options.relayHandler || new ApplesauceRelayPool(relays);
    const serverPubkey = options.serverPubkey;
    const { privateKey: _, ...rest } = options;

    this.transport = new NostrClientTransport({
      serverPubkey: serverPubkey || MlsDsCvmClient.SERVER_PUBKEY,
      signer,
      relayHandler,
      isStateless: true,
      ...rest,
    });

    // Auto-connect in constructor
    this.client.connect(this.transport).catch((error) => {
      console.error(`Failed to connect to server: ${error}`);
    });
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
  }

  private async call<T = unknown>(
    name: string,
    args: Record<string, unknown>
  ): Promise<T> {
    const result = await this.client.callTool({
      name,
      arguments: { ...args },
    });
    return result.structuredContent as T;
  }

    /**
   * Return Rust bridge status and contract metadata.
   * @returns {Promise<BridgeInfoOutput>} The result of the bridge_info operation
   */
  async BridgeInfo(
    args: BridgeInfoInput
  ): Promise<BridgeInfoOutput> {
    return this.call("bridge_info", args);
  }

    /**
   * Register or update a stable identity and its delivery addresses.
   * @param {string} stable_identity The stable_identity parameter
   * @param {string[]} delivery_addresses The delivery_addresses parameter
   * @returns {Promise<RegisterClientOutput>} The result of the register_client operation
   */
  async RegisterClient(
    stable_identity: string, delivery_addresses: string[]
  ): Promise<RegisterClientOutput> {
    return this.call("register_client", { stable_identity, delivery_addresses });
  }

    /**
   * List registered stable identities.
   * @returns {Promise<ListClientsOutput>} The result of the list_clients operation
   */
  async ListClients(
    args: ListClientsInput
  ): Promise<ListClientsOutput> {
    return this.call("list_clients", args);
  }

    /**
   * Publish OpenMLS key packages for a stable identity.
   * @param {string} stable_identity The stable_identity parameter
   * @param {object[]} key_packages The key_packages parameter
   * @returns {Promise<PublishKeyPackagesOutput>} The result of the publish_key_packages operation
   */
  async PublishKeyPackages(
    stable_identity: string, key_packages: object[]
  ): Promise<PublishKeyPackagesOutput> {
    return this.call("publish_key_packages", { stable_identity, key_packages });
  }

    /**
   * List published key packages for a stable identity.
   * @param {string} stable_identity The stable_identity parameter
   * @returns {Promise<GetKeyPackagesOutput>} The result of the get_key_packages operation
   */
  async GetKeyPackages(
    stable_identity: string
  ): Promise<GetKeyPackagesOutput> {
    return this.call("get_key_packages", { stable_identity });
  }

    /**
   * Reserve and consume one key package for a stable identity.
   * @param {string} stable_identity The stable_identity parameter
   * @returns {Promise<ConsumeKeyPackageOutput>} The result of the consume_key_package operation
   */
  async ConsumeKeyPackage(
    stable_identity: string
  ): Promise<ConsumeKeyPackageOutput> {
    return this.call("consume_key_package", { stable_identity });
  }

    /**
   * Store or replace the delivery route for a group.
   * @param {string} group_id The group_id parameter
   * @param {number} epoch The epoch parameter
   * @param {string[]} members The members parameter
   * @returns {Promise<PutGroupRouteOutput>} The result of the put_group_route operation
   */
  async PutGroupRoute(
    group_id: string, epoch: number, members: string[]
  ): Promise<PutGroupRouteOutput> {
    return this.call("put_group_route", { group_id, epoch, members });
  }

    /**
   * Store a welcome message targeted by stable identity and reserved key package reference.
   * @param {string} stable_identity The stable_identity parameter
   * @param {string} key_package_ref The key_package_ref parameter
   * @param {string} message_bytes The message_bytes parameter
   * @returns {Promise<SendWelcomeOutput>} The result of the send_welcome operation
   */
  async SendWelcome(
    stable_identity: string, key_package_ref: string, message_bytes: string
  ): Promise<SendWelcomeOutput> {
    return this.call("send_welcome", { stable_identity, key_package_ref, message_bytes });
  }

    /**
   * Drain welcome messages for a stable identity.
   * @param {string} stable_identity The stable_identity parameter
   * @returns {Promise<RecvWelcomesOutput>} The result of the recv_welcomes operation
   */
  async RecvWelcomes(
    stable_identity: string
  ): Promise<RecvWelcomesOutput> {
    return this.call("recv_welcomes", { stable_identity });
  }

    /**
   * Store a group message for routed recipients.
   * @param {string} group_id The group_id parameter
   * @param {number} epoch The epoch parameter
   * @param {string} sender The sender parameter
   * @param {string[]} recipients The recipients parameter
   * @param {string} message_bytes The message_bytes parameter
   * @returns {Promise<SendMessageOutput>} The result of the send_message operation
   */
  async SendMessage(
    group_id: string, epoch: number, sender: string, recipients: string[], message_bytes: string
  ): Promise<SendMessageOutput> {
    return this.call("send_message", { group_id, epoch, sender, recipients, message_bytes });
  }

    /**
   * Drain queued group messages for a delivery address.
   * @param {string} delivery_address The delivery_address parameter
   * @returns {Promise<RecvMessagesOutput>} The result of the recv_messages operation
   */
  async RecvMessages(
    delivery_address: string
  ): Promise<RecvMessagesOutput> {
    return this.call("recv_messages", { delivery_address });
  }
}
