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
import { MissingLocalKeyPackageForWelcomeError } from "./sessionErrors.ts";
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

export type GroupWatchStatus = "connecting" | "watching" | "errored";

export interface GroupListEntry {
  alias: string;
  metadata?: GroupSessionState["metadata"];
  lastCursor: number;
  messageCount: number;
  watchStatus: GroupWatchStatus | "idle";
  error?: string;
}

export interface WatchEvent {
  groupAlias: string;
  received: StoredMessage[];
  issues: SyncIssue[];
  watchStatus: GroupWatchStatus | "idle";
  error?: string;
}

interface GroupWatchHandle {
  abort: (reason?: string) => Promise<void>;
  task: Promise<void>;
  status: GroupWatchStatus;
  lastError?: string;
}

export class CliSession {
  readonly client: cordnClient;
  readonly privateKey: string;
  readonly stablePubkey: string;

  private readonly store = new CliSessionStore();
  private readonly groupIdDecoder = new TextDecoder();
  private readonly watchHandles = new Map<string, GroupWatchHandle>();
  private readonly watchListeners = new Set<(event: WatchEvent) => void>();

  constructor(options: CliSessionOptions = {}) {
    this.privateKey = options.privateKey ?? createPrivateKeyHex();
    this.client = new cordnClient({
      ...options,
      privateKey: this.privateKey,
    });
    this.stablePubkey = deriveStablePubkey(this.privateKey);
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled(
      [...this.watchHandles.keys()].map((groupAlias) =>
        this.unwatchGroup(groupAlias),
      ),
    );
    await this.client.disconnect().catch(() => undefined);
  }

  listKeyPackages(): StoredKeyPackage[] {
    return this.store.listKeyPackages();
  }

  listKeyPackageSummaries(): KeyPackageSummary[] {
    return this.listKeyPackages().map((entry) => ({
      alias: entry.alias,
      stablePubkey: this.stablePubkey,
      keyPackageRef: entry.keyPackageRef,
      isLastResort: entry.isLastResort,
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

  listGroupEntries(): GroupListEntry[] {
    return this.store.listGroups().map((group) => ({
      alias: group.alias,
      metadata: group.metadata,
      lastCursor: group.lastCursor,
      messageCount: group.messages.length,
      watchStatus: this.getWatchStatus(group.alias),
      error: this.watchHandles.get(group.alias)?.lastError,
    }));
  }

  onWatchEvent(listener: (event: WatchEvent) => void): () => void {
    this.watchListeners.add(listener);
    return () => {
      this.watchListeners.delete(listener);
    };
  }

  getWatchStatus(groupAlias: string): GroupWatchStatus | "idle" {
    return this.watchHandles.get(groupAlias)?.status ?? "idle";
  }

  isWatching(groupAlias: string): boolean {
    return this.watchHandles.has(groupAlias);
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

  async generateKeyPackage(
    alias?: string,
    options: { localOnly?: boolean; lastResort?: boolean } = {},
  ): Promise<StoredKeyPackage> {
    const resolvedAlias = alias ?? `kp-${this.store.keyPackageCount + 1}`;

    const generated = await createMemberArtifacts(this.stablePubkey, {
      lastResort: options.lastResort,
    });
    const stored: StoredKeyPackage = {
      alias: resolvedAlias,
      keyPackage: generated.keyPackage,
      privateKeyPackage: generated.privateKeyPackage,
      keyPackageRef: generated.keyPackageRef,
      keyPackageBase64: generated.keyPackageBase64,
      isLastResort: generated.isLastResort,
      consumed: false,
    };

    this.store.addKeyPackage(stored);

    if (!options.localOnly) {
      await this.publishKeyPackage(stored.alias);
    }

    return stored;
  }

  async publishKeyPackage(alias: string): Promise<StoredKeyPackage> {
    const stored = this.requireKeyPackage(alias);
    if (stored.publishedAt !== undefined) {
      return stored;
    }

    const result = await this.client.PublishKeyPackage({
      keyPackageRef: stored.keyPackageRef,
      keyPackageBase64: stored.keyPackageBase64,
    });
    stored.isLastResort = result.isLastResort;
    stored.publishedAt = result.publishedAt;
    return stored;
  }

  async deleteKeyPackage(
    aliasOrKeyPackageRef: string,
    options: { localOnly?: boolean } = {},
  ): Promise<{ keyPackageRef: string; removedLocal: boolean }> {
    const byRef = this.store.findKeyPackageByRef(aliasOrKeyPackageRef);
    const byAlias = byRef
      ? undefined
      : this.tryRequireKeyPackage(aliasOrKeyPackageRef);
    const keyPackageRef =
      byRef?.keyPackageRef ?? byAlias?.keyPackageRef ?? aliasOrKeyPackageRef;

    let removedLocal = false;
    if (byRef) {
      this.store.deleteKeyPackageByRef(keyPackageRef);
      removedLocal = true;
    } else if (byAlias) {
      this.store.deleteKeyPackage(aliasOrKeyPackageRef);
      removedLocal = true;
    }

    if (!options.localOnly) {
      if (!byRef && !byAlias) {
        const available = await this.listAvailableKeyPackages();
        const existsRemotely = available.some(
          (entry) => entry.keyPackageRef === keyPackageRef,
        );

        if (!existsRemotely) {
          throw new Error(`Unknown key package ref: ${keyPackageRef}`);
        }
      }

      await this.client.RemoveKeyPackages({ keyPackageRefs: [keyPackageRef] });
    }

    return { keyPackageRef, removedLocal };
  }

  async createGroup(
    alias: string,
    options: CreateGroupOptions = {},
  ): Promise<GroupSessionState> {
    const keyPackage = options.keyPackageAlias
      ? this.requireKeyPackage(options.keyPackageAlias)
      : (this.store.findUnconsumedKeyPackage() ??
        (await this.generateKeyPackage(undefined, { localOnly: true })));

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
      isLastResort: entry.isLastResort,
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
    await this.establishPostWelcomeBaseline(group, welcome.createdAt);
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
    const stored: StoredMessage = {
      cursor: 0,
      createdAt: Date.now(),
      direction: "outbound",
      sender: this.stablePubkey,
      plaintext,
      opaqueMessageBase64: outbound.opaqueMessageBase64,
    };

    group.messages.push(stored);
    try {
      const posted = await this.client.PostGroupMessage({
        opaqueMessageBase64: outbound.opaqueMessageBase64,
      });

      stored.cursor = posted.cursor;
      stored.createdAt = posted.createdAt;
      group.lastCursor = Math.max(group.lastCursor, posted.cursor);
    } catch (error) {
      const index = group.messages.indexOf(stored);
      if (index >= 0) {
        group.messages.splice(index, 1);
      }
      throw error;
    }

    return stored;
  }

  async syncGroup(groupAlias: string): Promise<StoredMessage[]> {
    if (this.isWatching(groupAlias)) {
      return [];
    }

    const group = this.getGroup(groupAlias);
    const result = await this.fetchRawGroupMessages(
      this.deriveGroupId(group.state),
      group.fetchCursor,
    );
    const { received } = await this.applyIncomingMessages(group, result.messages);
    return received;
  }

  async watchGroup(groupAlias: string): Promise<void> {
    if (this.watchHandles.has(groupAlias)) {
      return;
    }

    const group = this.getGroup(groupAlias);
    const groupId = this.deriveGroupId(group.state);

    const task = (async () => {
      this.setWatchStatus(groupAlias, "connecting");

      const catchup = await this.fetchRawGroupMessages(groupId, group.fetchCursor);
      const catchupResult = await this.applyIncomingMessages(group, catchup.messages);
      this.emitWatchEvent(groupAlias, catchupResult.received, catchupResult.issues);

      const subscription = await this.client.SubscribeGroupMessages({
        groupId,
        afterCursor: group.fetchCursor > 0 ? group.fetchCursor : undefined,
      });
      void subscription.result.catch(() => undefined);

      const handle = this.watchHandles.get(groupAlias);
      if (handle) {
        handle.abort = async (reason?: string) => {
          await subscription.abort(reason).catch(() => undefined);
        };
      }

      this.setWatchStatus(groupAlias, "watching");

      for await (const message of subscription.stream) {
        const streamed = await this.applyIncomingMessages(group, [message]);
        this.emitWatchEvent(groupAlias, streamed.received, streamed.issues);
      }
    })().catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.setWatchStatus(groupAlias, "errored", reason);
    });

    this.watchHandles.set(groupAlias, {
      abort: async () => undefined,
      task,
      status: "connecting",
    });
  }

  async unwatchGroup(groupAlias: string): Promise<void> {
    const handle = this.watchHandles.get(groupAlias);
    if (!handle) {
      return;
    }

    this.watchHandles.delete(groupAlias);
    await handle.abort("user requested stop").catch(() => undefined);
    await handle.task.catch(() => undefined);
    this.emitWatchEvent(groupAlias, [], []);
  }

  async watchAllGroups(): Promise<void> {
    for (const group of this.listGroups()) {
      await this.watchGroup(group.alias);
    }
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

  private tryRequireKeyPackage(alias: string): StoredKeyPackage | undefined {
    try {
      return this.requireKeyPackage(alias);
    } catch {
      return undefined;
    }
  }

  private deriveGroupId(state: ClientState): string {
    return this.groupIdDecoder.decode(state.groupContext.groupId);
  }

  private async applyIncomingMessages(
    group: GroupSessionState,
    messages: FetchGroupMessagesOutput["messages"],
    options: {
      suppressIssue?: (issue: SyncIssue) => boolean;
    } = {},
  ): Promise<{ received: StoredMessage[]; issues: SyncIssue[] }> {
    const previousIssueCount = group.syncIssues.length;
    const sync = await applyGroupSync({
      group,
      messages,
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

    return {
      received: sync.received,
      issues: options.suppressIssue
        ? this.removeSuppressedIssues(
            group,
            previousIssueCount,
            options.suppressIssue,
          )
        : group.syncIssues.slice(previousIssueCount),
    };
  }

  private async establishPostWelcomeBaseline(
    group: GroupSessionState,
    welcomeCreatedAt: number,
  ): Promise<void> {
    const result = await this.fetchRawGroupMessages(
      this.deriveGroupId(group.state),
      group.fetchCursor,
    );

    await this.applyIncomingMessages(group, result.messages, {
      suppressIssue: (issue) =>
        issue.createdAt <= welcomeCreatedAt &&
        (issue.detail === "Cannot process commit or proposal from former epoch" ||
          issue.detail === "Cannot process message, epoch too old"),
    });
  }

  private removeSuppressedIssues(
    group: GroupSessionState,
    previousIssueCount: number,
    suppressIssue: (issue: SyncIssue) => boolean,
  ): SyncIssue[] {
    const added = group.syncIssues.slice(previousIssueCount);
    const unsuppressed = added.filter((issue) => !suppressIssue(issue));

    group.syncIssues.splice(previousIssueCount, added.length, ...unsuppressed);
    return unsuppressed;
  }

  private setWatchStatus(
    groupAlias: string,
    status: GroupWatchStatus,
    lastError?: string,
  ): void {
    const handle = this.watchHandles.get(groupAlias);
    if (!handle) {
      return;
    }

    handle.status = status;
    handle.lastError = lastError;
    this.emitWatchEvent(groupAlias, [], []);
  }

  private emitWatchEvent(
    groupAlias: string,
    received: StoredMessage[],
    issues: SyncIssue[],
  ): void {
    const handle = this.watchHandles.get(groupAlias);
    const event: WatchEvent = {
      groupAlias,
      received,
      issues,
      watchStatus: handle?.status ?? "idle",
      error: handle?.lastError,
    };

    for (const listener of this.watchListeners) {
      listener(event);
    }
  }
}
