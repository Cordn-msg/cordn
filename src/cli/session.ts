import {
  decode,
  keyPackageDecoder,
  type ClientState,
  type KeyPackage,
  type PrivateKeyPackage,
} from "ts-mls";

import {
  getCordnGroupMetadataExtension,
  type CordnGroupMetadata,
} from "./groupMetadata.ts";
import {
  addMemberToGroup,
  createApplicationMessageBase64,
  createGroupState,
  createMemberArtifacts,
  createPrivateKeyHex,
  decodeApplicationData,
  decodeAuthenticatedSender,
  decodeBase64,
  decodeWelcomeBase64,
  deriveStablePubkey,
  encodeAuthenticatedSender,
  encodeWelcomeBase64,
  joinGroupFromWelcome,
  keyPackageSupportsCordnMetadata,
  processMessageBase64,
} from "./utils.ts";
import {
  type AvailableKeyPackage as ContractAvailableKeyPackage,
  type FetchGroupMessagesOutput,
  type ListAvailableKeyPackagesOutput,
  type PendingWelcome,
} from "../contracts/index.ts";
import type { RelayHandler } from "@contextvm/sdk";
import { cvmCoordinatorClient } from "./coordinatorClient.ts";

export interface CliSessionOptions {
  privateKey?: string;
  serverPubkey?: string;
  relays?: string[];
  relayHandler?: RelayHandler;
}

export interface SessionStatus {
  stablePubkey: string;
  keyPackageCount: number;
  welcomeCount: number;
  groupCount: number;
}

export interface StoredKeyPackage {
  alias: string;
  keyPackage: KeyPackage;
  privateKeyPackage: PrivateKeyPackage;
  keyPackageRef: string;
  keyPackageBase64: string;
  publishedAt?: number;
  consumed: boolean;
}

export interface KeyPackageSummary {
  alias?: string;
  stablePubkey: string;
  keyPackageRef: string;
  publishedAt?: number;
  consumed?: boolean;
  supportsGroupMetadata: boolean;
}

export interface StoredMessage {
  cursor: number;
  createdAt: number;
  direction: "inbound" | "outbound";
  sender: string;
  plaintext: string;
}

export interface SyncIssue {
  cursor: number;
  createdAt: number;
  detail: string;
}

export interface GroupSessionState {
  alias: string;
  state: ClientState;
  metadata?: CordnGroupMetadata;
  lastCursor: number;
  messages: StoredMessage[];
  syncIssues: SyncIssue[];
}

export interface CreateGroupOptions {
  groupId?: string;
  keyPackageAlias?: string;
  metadata?: CordnGroupMetadata;
}

export interface ConversationView {
  synced: StoredMessage[];
  messages: StoredMessage[];
}

export class CliSession {
  readonly client: cvmCoordinatorClient;
  readonly privateKey: string;
  readonly stablePubkey: string;

  private readonly keyPackages = new Map<string, StoredKeyPackage>();
  private readonly welcomes = new Map<string, PendingWelcome>();
  private readonly groups = new Map<string, GroupSessionState>();
  private readonly groupIdDecoder = new TextDecoder();

  constructor(options: CliSessionOptions = {}) {
    this.privateKey = options.privateKey ?? createPrivateKeyHex();
    this.client = new cvmCoordinatorClient({
      ...options,
      privateKey: this.privateKey,
    });
    this.stablePubkey = deriveStablePubkey(this.privateKey);
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  listKeyPackages(): StoredKeyPackage[] {
    return [...this.keyPackages.values()];
  }

  listKeyPackageSummaries(): KeyPackageSummary[] {
    return this.listKeyPackages().map((entry) => ({
      alias: entry.alias,
      stablePubkey: this.stablePubkey,
      keyPackageRef: entry.keyPackageRef,
      publishedAt: entry.publishedAt,
      consumed: entry.consumed,
      supportsGroupMetadata: keyPackageSupportsCordnMetadata(entry.keyPackage),
    }));
  }

  listWelcomes(): PendingWelcome[] {
    return [...this.welcomes.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  listGroups(): GroupSessionState[] {
    return [...this.groups.values()];
  }

  getStatus(): SessionStatus {
    return {
      stablePubkey: this.stablePubkey,
      keyPackageCount: this.keyPackages.size,
      welcomeCount: this.welcomes.size,
      groupCount: this.groups.size,
    };
  }

  getGroup(alias: string): GroupSessionState {
    const group = this.groups.get(alias);

    if (!group) {
      throw new Error(`Unknown group alias: ${alias}`);
    }

    return group;
  }

  async generateKeyPackage(alias?: string): Promise<StoredKeyPackage> {
    const resolvedAlias = alias ?? `kp-${this.keyPackages.size + 1}`;

    if (this.keyPackages.has(resolvedAlias)) {
      throw new Error(`Key package alias already exists: ${resolvedAlias}`);
    }

    const generated = await createMemberArtifacts(this.stablePubkey);
    const stored: StoredKeyPackage = {
      alias: resolvedAlias,
      keyPackage: generated.keyPackage,
      privateKeyPackage: generated.privateKeyPackage,
      keyPackageRef: generated.keyPackageRef,
      keyPackageBase64: generated.keyPackageBase64,
      consumed: false,
    };

    this.keyPackages.set(resolvedAlias, stored);
    return stored;
  }

  async publishKeyPackage(alias: string): Promise<StoredKeyPackage> {
    const stored = this.requireKeyPackage(alias);
    const result = await this.client.PublishKeyPackage({
      keyPackageRef: stored.keyPackageRef,
      keyPackageBase64: stored.keyPackageBase64,
    });
    stored.publishedAt = result.publishedAt;
    return stored;
  }

  async createGroup(
    alias: string,
    options: CreateGroupOptions = {},
  ): Promise<GroupSessionState> {
    if (this.groups.has(alias)) {
      throw new Error(`Group alias already exists: ${alias}`);
    }

    const keyPackage = options.keyPackageAlias
      ? this.requireKeyPackage(options.keyPackageAlias)
      : this.findUnconsumedKeyPackage();

    if (!keyPackage) {
      throw new Error("No available local key package. Generate one first.");
    }

    const state = await createGroupState({
      groupId: options.groupId ?? crypto.randomUUID(),
      keyPackage: keyPackage.keyPackage,
      privateKeyPackage: keyPackage.privateKeyPackage,
      metadata: options.metadata,
    });

    const group = this.createGroupSessionState(alias, state);

    this.groups.set(alias, group);
    return group;
  }

  async addMember(
    groupAlias: string,
    identifier: string,
  ): Promise<{ keyPackageReference: string }> {
    const group = this.getGroup(groupAlias);
    const consumeResult = await this.client.ConsumeKeyPackage({
      identifier,
    });

    if (!consumeResult.keyPackage) {
      throw new Error(`No published key package available for ${identifier}`);
    }

    const memberKeyPackage = decode(
      keyPackageDecoder,
      decodeBase64(consumeResult.keyPackage.keyPackageBase64),
    );

    if (!memberKeyPackage) {
      throw new Error("Unable to decode consumed key package");
    }

    const commitResult = await addMemberToGroup({
      state: group.state,
      memberKeyPackage,
    });

    group.state = commitResult.newState;

    await this.client.StoreWelcome({
      targetStablePubkey: consumeResult.keyPackage.stablePubkey,
      keyPackageReference: consumeResult.keyPackage.keyPackageRef,
      welcomeBase64: encodeWelcomeBase64(commitResult.welcome),
    });

    await this.client.PostGroupMessage({
      opaqueMessageBase64: commitResult.commitMessageBase64,
    });

    return { keyPackageReference: consumeResult.keyPackage.keyPackageRef };
  }

  async fetchWelcomes(): Promise<PendingWelcome[]> {
    const result = await this.client.FetchPendingWelcomes({});

    for (const welcome of result.welcomes) {
      this.welcomes.set(welcome.keyPackageReference, welcome);
    }

    return this.listWelcomes();
  }

  async listAvailableKeyPackages(): Promise<ContractAvailableKeyPackage[]> {
    const result: ListAvailableKeyPackagesOutput =
      await this.client.ListAvailableKeyPackages({});
    return result.keyPackages;
  }

  async listAvailableKeyPackageSummaries(): Promise<KeyPackageSummary[]> {
    const keyPackages = await this.listAvailableKeyPackages();
    return keyPackages.map((entry) => ({
      stablePubkey: entry.stablePubkey,
      keyPackageRef: entry.keyPackageRef,
      publishedAt: entry.publishedAt,
      supportsGroupMetadata: true,
    }));
  }

  async acceptWelcome(
    keyPackageReference: string,
    groupAlias?: string,
  ): Promise<GroupSessionState> {
    const welcome = this.welcomes.get(keyPackageReference);

    if (!welcome) {
      throw new Error(
        `Unknown welcome key package reference: ${keyPackageReference}`,
      );
    }

    const keyPackage = this.findKeyPackageByRef(welcome.keyPackageReference);

    if (!keyPackage) {
      throw new Error(
        `No local key package matches welcome reference ${welcome.keyPackageReference}`,
      );
    }

    const alias = groupAlias ?? `group-${this.groups.size + 1}`;

    if (this.groups.has(alias)) {
      throw new Error(`Group alias already exists: ${alias}`);
    }

    const joinState = await joinGroupFromWelcome({
      welcome: decodeWelcomeBase64(welcome.welcomeBase64),
      keyPackage: keyPackage.keyPackage,
      privateKeyPackage: keyPackage.privateKeyPackage,
    });

    const group = this.createGroupSessionState(alias, joinState);

    group.lastCursor = 0;

    this.groups.set(alias, group);
    keyPackage.consumed = true;
    this.welcomes.delete(keyPackageReference);

    return this.getGroup(alias);
  }

  async sendMessage(
    groupAlias: string,
    plaintext: string,
  ): Promise<StoredMessage> {
    const group = this.getGroup(groupAlias);
    const outbound = await createApplicationMessageBase64({
      state: group.state,
      plaintext,
      authenticatedData: encodeAuthenticatedSender(this.stablePubkey),
    });

    group.state = outbound.newState;
    const posted = await this.client.PostGroupMessage({
      opaqueMessageBase64: outbound.opaqueMessageBase64,
    });
    const stored: StoredMessage = {
      cursor: posted.cursor,
      createdAt: posted.createdAt,
      direction: "outbound",
      sender: this.stablePubkey,
      plaintext,
    };

    group.messages.push(stored);
    group.lastCursor = Math.max(group.lastCursor, posted.cursor);
    return stored;
  }

  async syncGroup(groupAlias: string): Promise<StoredMessage[]> {
    const group = this.getGroup(groupAlias);
    const result = await this.fetchRawGroupMessages(
      this.deriveGroupId(group.state),
      group.lastCursor,
    );
    const received: StoredMessage[] = [];

    for (const message of result.messages) {
      let processed: Awaited<ReturnType<typeof processMessageBase64>>;

      try {
        processed = await processMessageBase64({
          state: group.state,
          opaqueMessageBase64: message.opaqueMessageBase64,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);

        if (
          detail === "Cannot process commit or proposal from former epoch" ||
          detail === "Cannot process message, epoch too old"
        ) {
          group.lastCursor = message.cursor;
          group.syncIssues.push({
            cursor: message.cursor,
            createdAt: message.createdAt,
            detail,
          });
          continue;
        }

        throw error;
      }

      if (processed.kind === "applicationMessage") {
        group.state = processed.newState;
        group.metadata = getCordnGroupMetadataExtension(processed.newState);
        group.lastCursor = message.cursor;

        const stored: StoredMessage = {
          cursor: message.cursor,
          createdAt: message.createdAt,
          direction: "inbound",
          sender:
            processed.aad.length > 0
              ? decodeAuthenticatedSender(processed.aad)
              : "peer",
          plaintext: decodeApplicationData(processed.message),
        };

        group.messages.push(stored);
        received.push(stored);
        continue;
      }

      if (processed.kind !== "newState") {
        group.lastCursor = message.cursor;
        continue;
      }

      group.state = processed.newState;
      group.metadata = getCordnGroupMetadataExtension(processed.newState);
      group.lastCursor = message.cursor;
    }

    return received;
  }

  async syncAll(): Promise<Record<string, StoredMessage[]>> {
    const entries = await Promise.all(
      this.listGroups().map(
        async (group) =>
          [group.alias, await this.syncGroup(group.alias)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  async getConversation(groupAlias: string): Promise<ConversationView> {
    const synced = await this.syncGroup(groupAlias);

    return {
      synced,
      messages: this.listMessages(groupAlias),
    };
  }

  listMessages(groupAlias: string): StoredMessage[] {
    return [...this.getGroup(groupAlias).messages].sort(
      (a, b) => a.cursor - b.cursor,
    );
  }

  listSyncIssues(groupAlias: string): SyncIssue[] {
    return [...this.getGroup(groupAlias).syncIssues].sort(
      (a, b) => a.cursor - b.cursor,
    );
  }

  private async fetchRawGroupMessages(
    groupId: string,
    afterCursor: number,
  ): Promise<FetchGroupMessagesOutput> {
    return this.client.FetchGroupMessages({
      groupId,
      afterCursor: afterCursor > 0 ? afterCursor : undefined,
    });
  }

  private createGroupSessionState(
    alias: string,
    state: ClientState,
  ): GroupSessionState {
    return {
      alias,
      state,
      metadata: getCordnGroupMetadataExtension(state),
      lastCursor: 0,
      messages: [],
      syncIssues: [],
    };
  }

  private findUnconsumedKeyPackage(): StoredKeyPackage | undefined {
    for (const keyPackage of this.keyPackages.values()) {
      if (!keyPackage.consumed) {
        return keyPackage;
      }
    }

    return undefined;
  }

  private requireKeyPackage(alias: string): StoredKeyPackage {
    const keyPackage = this.keyPackages.get(alias);

    if (!keyPackage) {
      throw new Error(`Unknown key package alias: ${alias}`);
    }

    return keyPackage;
  }

  private findKeyPackageByRef(
    keyPackageRef: string,
  ): StoredKeyPackage | undefined {
    for (const candidate of this.keyPackages.values()) {
      if (candidate.keyPackageRef === keyPackageRef) {
        return candidate;
      }
    }

    return undefined;
  }

  private deriveGroupId(state: ClientState): string {
    return this.groupIdDecoder.decode(state.groupContext.groupId);
  }
}
