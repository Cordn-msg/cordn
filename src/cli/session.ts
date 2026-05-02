import { type ClientState } from "ts-mls";

import { getCordnGroupMetadataExtension } from "./groupMetadata.ts";
import {
  createApplicationMessageBase64,
  encodeAuthenticatedSender,
} from "./utils/mlsMessages.ts";
import {
  createPrivateKeyHex,
  deriveStablePubkey,
  createMemberArtifacts,
  keyPackageSupportsCordnMetadata,
} from "./utils/mlsIdentity.ts";
import { createGroupState } from "./utils/mlsGroupLifecycle.ts";
import {
  type AvailableKeyPackage as ContractAvailableKeyPackage,
  type FetchGroupMessagesOutput,
  type ListAvailableKeyPackagesOutput,
} from "../contracts/index.ts";
import { cordnClient } from "./coordinatorClient.ts";
import { applyGroupSync } from "./groupSync.ts";
import { acceptStoredWelcome, prepareAddMember } from "./membershipFlow.ts";
import type {
  CliSessionOptions,
  ConversationView,
  CreateGroupOptions,
  GroupSessionState,
  KeyPackageSummary,
  SessionStatus,
  SyncIssue,
  StoredKeyPackage,
  StoredMessage,
  StoredWelcome,
} from "./sessionState.ts";

import {
  confirmPendingEpochOperations,
  enqueuePendingEpochOperation,
  hasPendingEpochOperation,
  rejectPendingEpochOperations,
} from "./pendingEpochOperations.ts";
import {
  MissingLocalKeyPackageForWelcomeError,
  NoAvailableKeyPackageError,
} from "./sessionErrors.ts";
import { CliSessionStore } from "./sessionStore.ts";
export type {
  CliSessionOptions,
  ConversationView,
  CreateGroupOptions,
  GroupSessionState,
  KeyPackageSummary,
  SessionStatus,
  StoredKeyPackage,
  StoredMessage,
  StoredWelcome,
} from "./sessionState.ts";

export class CliSession {
  readonly client: cordnClient;
  readonly privateKey: string;
  readonly stablePubkey: string;

  private readonly store = new CliSessionStore();
  private readonly groupIdDecoder = new TextDecoder();

  constructor(options: CliSessionOptions = {}) {
    this.privateKey = options.privateKey ?? createPrivateKeyHex();
    this.client = new cordnClient({
      ...options,
      privateKey: this.privateKey,
    });
    this.stablePubkey = deriveStablePubkey(this.privateKey);
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  listKeyPackages(): StoredKeyPackage[] {
    return this.store.listKeyPackages();
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

  listWelcomes(): StoredWelcome[] {
    return this.store.listWelcomes();
  }

  listGroups(): GroupSessionState[] {
    return this.store.listGroups();
  }

  getStatus(): SessionStatus {
    return {
      stablePubkey: this.stablePubkey,
      keyPackageCount: this.store.keyPackageCount,
      welcomeCount: this.store.welcomeCount,
      groupCount: this.store.groupCount,
    };
  }

  getGroup(alias: string): GroupSessionState {
    return this.store.getGroup(alias);
  }

  async generateKeyPackage(alias?: string): Promise<StoredKeyPackage> {
    const resolvedAlias = alias ?? `kp-${this.store.keyPackageCount + 1}`;

    const generated = await createMemberArtifacts(this.stablePubkey);
    const stored: StoredKeyPackage = {
      alias: resolvedAlias,
      keyPackage: generated.keyPackage,
      privateKeyPackage: generated.privateKeyPackage,
      keyPackageRef: generated.keyPackageRef,
      keyPackageBase64: generated.keyPackageBase64,
      consumed: false,
    };

    this.store.addKeyPackage(stored);
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
    const keyPackage = options.keyPackageAlias
      ? this.requireKeyPackage(options.keyPackageAlias)
      : this.store.findUnconsumedKeyPackage();

    if (!keyPackage) {
      throw new NoAvailableKeyPackageError();
    }

    const state = await createGroupState({
      groupId: options.groupId ?? crypto.randomUUID(),
      keyPackage: keyPackage.keyPackage,
      privateKeyPackage: keyPackage.privateKeyPackage,
      metadata: options.metadata,
    });

    const group = this.createGroupSessionState(alias, state);

    this.store.addGroup(group);
    return group;
  }

  async addMember(
    groupAlias: string,
    identifier: string,
  ): Promise<{ keyPackageReference: string }> {
    const group = this.getGroup(groupAlias);
    const prepared = await prepareAddMember({
      groupAlias,
      group,
      identifier,
      consumeKeyPackage: (params) => this.client.ConsumeKeyPackage(params),
      deriveGroupId: (state) => this.deriveGroupId(state),
    });

    enqueuePendingEpochOperation(
      this.store.pendingOperations,
      prepared.pendingOperation,
    );

    await this.client.PostGroupMessage({
      opaqueMessageBase64: prepared.commitMessageBase64,
    });

    return { keyPackageReference: prepared.keyPackageReference };
  }

  async fetchWelcomes(): Promise<StoredWelcome[]> {
    const result = await this.client.FetchPendingWelcomes({});

    for (const welcome of result.welcomes) {
      this.store.putWelcome(welcome);
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
    const welcome = this.store.getWelcome(keyPackageReference);
    const keyPackage = this.store.findKeyPackageByRef(
      welcome.keyPackageReference,
    );

    if (!keyPackage) {
      throw new MissingLocalKeyPackageForWelcomeError(
        welcome.keyPackageReference,
      );
    }

    const alias = groupAlias ?? `group-${this.store.groupCount + 1}`;

    const group = await acceptStoredWelcome({
      keyPackageReference,
      groupAlias: alias,
      welcome,
      keyPackage,
      createGroupSessionState: (resolvedAlias, state) =>
        this.createGroupSessionState(resolvedAlias, state),
    });

    this.store.addGroup(group);
    this.store.deleteWelcome(keyPackageReference);

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
      group.fetchCursor,
    );
    const sync = await applyGroupSync({
      group,
      messages: result.messages,
      hasPendingEpochOperation: (opaqueMessageBase64) =>
        hasPendingEpochOperation(
          this.store.pendingOperations,
          group.alias,
          opaqueMessageBase64,
        ),
    });

    await confirmPendingEpochOperations(
      this.store.pendingOperations,
      this.client,
      {
        groupAlias: group.alias,
        opaqueMessageBase64s: [...sync.appliedPendingCommitMessages],
      },
    );

    if (sync.rejectedPendingCommitMessages.size > 0) {
      await rejectPendingEpochOperations(this.store.pendingOperations, {
        groupAlias: group.alias,
        opaqueMessageBase64s: [...sync.rejectedPendingCommitMessages],
      });
    }

    return sync.received;
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
      fetchCursor: 0,
      messages: [],
      syncIssues: [],
    };
  }

  private requireKeyPackage(alias: string): StoredKeyPackage {
    return this.store.getKeyPackage(alias);
  }

  private deriveGroupId(state: ClientState): string {
    return this.groupIdDecoder.decode(state.groupContext.groupId);
  }
}
