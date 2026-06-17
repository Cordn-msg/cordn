import { type ClientState } from "ts-mls";

import { assertCanAdministerGroup } from "./adminPolicy.ts";
import {
  getCordnGroupMetadataExtension,
  type CordnGroupMetadata,
} from "./groupMetadata.ts";
import { createUnsignedCordnMessageEvent } from "./messageEnvelope.ts";
import {
  createApplicationMessageBase64,
  decryptGroupPayload,
  encodeAuthenticatedSender,
  encryptGroupPayload,
} from "./utils/mlsMessages.ts";
import { decodeBase64, encodeBase64 } from "./utils/mlsBase.ts";
import {
  createPrivateKeyHex,
  deriveStablePubkey,
  createMemberArtifacts,
  keyPackageSupportsCordnMetadata,
} from "./utils/mlsIdentity.ts";
import {
  createGroupState,
  updateGroupMetadataExtension,
} from "./utils/mlsGroupLifecycle.ts";
import {
  type AvailableKeyPackage as ContractAvailableKeyPackage,
  type FetchGroupMessagesOutput,
  type ListAvailableKeyPackagesOutput,
} from "../contracts/index.ts";
import { CoordinatorClientRegistry } from "./coordinatorRegistry.ts";
import { ingestGroupMessages } from "./groupSync.ts";
import type { FetchPendingJoinRequestsOutput } from "../contracts/index.ts";
import { runGroupWatch } from "./groupWatch.ts";
import {
  acceptStoredWelcome,
  prepareAddMember,
  prepareRemoveMember,
} from "./membershipFlow.ts";
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
  getPendingEpochOperation,
  markPendingEpochOperationsConfirmed,
  rejectPendingEpochOperations,
  type PendingEpochOperation,
} from "./pendingEpochOperations.ts";
import {
  MissingLocalKeyPackageForWelcomeError,
  RemovedFromGroupError,
  SelfRemovalNotSupportedError,
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

export type GroupEvent =
  | {
      type: "watch-status-changed";
      groupAlias: string;
      watchStatus: GroupWatchStatus | "idle";
      error?: string;
    }
  | {
      type: "messages-ingested";
      groupAlias: string;
      watchStatus: GroupWatchStatus | "idle";
      received: StoredMessage[];
      issues: SyncIssue[];
      error?: string;
    };

interface GroupWatchHandle {
  abort: (reason?: string) => Promise<void>;
  task: Promise<void>;
  status: GroupWatchStatus;
  lastError?: string;
}

export class CliSession {
  readonly privateKey: string;
  readonly stablePubkey: string;

  private readonly store = new CliSessionStore();
  private readonly coordinatorRegistry: CoordinatorClientRegistry;
  private readonly groupIdDecoder = new TextDecoder();
  private readonly watchHandles = new Map<string, GroupWatchHandle>();
  private readonly groupEventListeners = new Set<(event: GroupEvent) => void>();
  private readonly groupOperations = new Map<string, Promise<void>>();

  constructor(options: CliSessionOptions = {}) {
    this.privateKey = options.privateKey ?? createPrivateKeyHex();
    this.coordinatorRegistry = new CoordinatorClientRegistry({
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
    await this.coordinatorRegistry.disconnect().catch(() => undefined);
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
    const unsubscribe = this.onGroupEvent((event) => {
      if (event.type === "watch-status-changed") {
        listener({
          groupAlias: event.groupAlias,
          received: [],
          issues: [],
          watchStatus: event.watchStatus,
          error: event.error,
        });
        return;
      }

      listener({
        groupAlias: event.groupAlias,
        received: event.received,
        issues: event.issues,
        watchStatus: event.watchStatus,
        error: event.error,
      });
    });

    return () => {
      unsubscribe();
    };
  }

  onGroupEvent(listener: (event: GroupEvent) => void): () => void {
    this.groupEventListeners.add(listener);
    return () => {
      this.groupEventListeners.delete(listener);
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
    options: {
      localOnly?: boolean;
      lastResort?: boolean;
      coordinatorKey?: string;
    } = {},
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
      await this.publishKeyPackage(stored.alias, {
        coordinatorKey: options.coordinatorKey,
      });
    }

    return stored;
  }

  async publishKeyPackage(
    alias: string,
    options: { coordinatorKey?: string } = {},
  ): Promise<StoredKeyPackage> {
    const stored = this.requireKeyPackage(alias);
    if (stored.publishedAt !== undefined) {
      return stored;
    }

    const result = await this.getCoordinatorClient(
      options.coordinatorKey,
    ).PublishKeyPackage({
      kp_ref: stored.keyPackageRef,
      kp_64: stored.keyPackageBase64,
    });
    stored.isLastResort = result.last_resort;
    stored.publishedAt = result.at;
    return stored;
  }

  async deleteKeyPackage(
    aliasOrKeyPackageRef: string,
    options: { localOnly?: boolean; coordinatorKey?: string } = {},
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
        const available = await this.listAvailableKeyPackages(
          options.coordinatorKey,
        );
        const existsRemotely = available.some(
          (entry) => entry.kp_ref === keyPackageRef,
        );

        if (!existsRemotely) {
          throw new Error(`Unknown key package ref: ${keyPackageRef}`);
        }
      }

      await this.getCoordinatorClient(options.coordinatorKey).RemoveKeyPackages(
        {
          kp_refs: [keyPackageRef],
        },
      );
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

    const group = this.createGroupSessionState(
      alias,
      state,
      this.resolveCoordinatorKey(options.coordinatorKey),
    );

    this.store.addGroup(group);
    return group;
  }

  async addMember(
    groupAlias: string,
    identifier: string,
  ): Promise<{ keyPackageReference: string }> {
    return this.runGroupOperation(groupAlias, async () => {
      const group = this.getGroup(groupAlias);
      const client = this.getGroupClient(group);
      await this.catchUpGroupIfNeeded(group);
      this.assertGroupIsActive(group);
      assertCanAdministerGroup({
        groupAlias,
        metadata: group.metadata,
        stablePubkey: this.stablePubkey,
      });
      const prepared = await prepareAddMember({
        groupAlias,
        group,
        identifier,
        consumeKeyPackage: async (params) => {
          const result = await client.ConsumeKeyPackage({
            id: params.identifier,
          });

          return {
            keyPackage: result.keyPackage
              ? {
                  keyPackageRef: result.keyPackage.kp_ref,
                  stablePubkey: result.keyPackage.pk,
                  publicationEvent: result.keyPackage.event,
                }
              : null,
          };
        },
        deriveGroupId: (state) => this.deriveGroupId(state),
      });

      enqueuePendingEpochOperation(
        this.store.pendingOperations,
        prepared.pendingOperation,
      );

      // Encrypt with the *current* (pre-commit) state so that all
      // existing group members can decrypt the commit.  The posted
      // wrapper is saved on the pending operation so the self-echo
      // can be matched before decryption when the session has already
      // advanced to the new epoch.
      const posted = await this.postEncryptedGroupMessage(
        group,
        prepared.commitMessageBase64,
      );
      prepared.pendingOperation.joinAfterCursor = posted.cursor;
      prepared.pendingOperation.postedMsgBase64 = posted.postedMsgBase64;

      this.adoptGroupState(group, prepared.newState);

      return { keyPackageReference: prepared.keyPackageReference };
    });
  }

  async removeMember(
    groupAlias: string,
    targetStablePubkey: string,
  ): Promise<{ targetStablePubkey: string }> {
    return this.runGroupOperation(groupAlias, async () => {
      const group = this.getGroup(groupAlias);
      await this.catchUpGroupIfNeeded(group);
      this.assertGroupIsActive(group);
      assertCanAdministerGroup({
        groupAlias,
        metadata: group.metadata,
        stablePubkey: this.stablePubkey,
      });

      if (targetStablePubkey === this.stablePubkey) {
        throw new SelfRemovalNotSupportedError(groupAlias);
      }

      const prepared = await prepareRemoveMember({
        groupAlias,
        group,
        targetStablePubkey,
        deriveGroupId: (state) => this.deriveGroupId(state),
      });

      enqueuePendingEpochOperation(
        this.store.pendingOperations,
        prepared.pendingOperation,
      );

      const posted = await this.postEncryptedGroupMessage(
        group,
        prepared.commitMessageBase64,
      );
      prepared.pendingOperation.postedMsgBase64 = posted.postedMsgBase64;

      this.adoptGroupState(group, prepared.newState);

      return { targetStablePubkey };
    });
  }

  async updateGroupMetadata(
    groupAlias: string,
    metadata: CordnGroupMetadata,
  ): Promise<{ metadata: CordnGroupMetadata }> {
    return this.runGroupOperation(groupAlias, async () => {
      const group = this.getGroup(groupAlias);
      await this.catchUpGroupIfNeeded(group);
      this.assertGroupIsActive(group);
      assertCanAdministerGroup({
        groupAlias,
        metadata: group.metadata,
        stablePubkey: this.stablePubkey,
      });

      const prepared = await updateGroupMetadataExtension({
        state: group.state,
        metadata,
      });

      enqueuePendingEpochOperation(this.store.pendingOperations, {
        kind: "update-group-metadata",
        groupAlias,
        groupId: this.deriveGroupId(group.state),
        commitMessageBase64: prepared.commitMessageBase64,
        status: "pending",
      });

      const posted = await this.postEncryptedGroupMessage(
        group,
        prepared.commitMessageBase64,
      );
      const pendingOp = this.store.pendingOperations
        .get(groupAlias)
        ?.find((op) => op.commitMessageBase64 === prepared.commitMessageBase64);
      if (pendingOp) {
        pendingOp.postedMsgBase64 = posted.postedMsgBase64;
      }

      this.adoptGroupState(group, prepared.newState);

      return { metadata: group.metadata ?? metadata };
    });
  }

  async fetchWelcomes(coordinatorKey?: string): Promise<StoredWelcome[]> {
    const resolvedCoordinatorKey = this.resolveCoordinatorKey(coordinatorKey);
    const result = await this.getCoordinatorClient(
      resolvedCoordinatorKey,
    ).FetchPendingWelcomes({});

    for (const welcome of result.welcomes) {
      // Skip welcomes that were already accepted (their kp_ref was deleted
      // from the local store after acceptance). With non-destructive
      // FetchPendingWelcomes on the coordinator, the same welcome may be
      // returned across multiple fetches.
      if (!this.store.hasWelcome(welcome.kp_ref)) {
        this.store.putWelcome({
          ...welcome,
          coordinatorKey: resolvedCoordinatorKey,
        });
      }
    }

    return this.listWelcomes();
  }

  async listAvailableKeyPackages(
    coordinatorKey?: string,
  ): Promise<ContractAvailableKeyPackage[]> {
    const result: ListAvailableKeyPackagesOutput =
      await this.getCoordinatorClient(coordinatorKey).ListAvailableKeyPackages(
        {},
      );
    return result.keyPackages;
  }

  async listAvailableKeyPackageSummaries(
    coordinatorKey?: string,
  ): Promise<KeyPackageSummary[]> {
    const keyPackages = await this.listAvailableKeyPackages(coordinatorKey);
    return keyPackages.map((entry) => ({
      stablePubkey: entry.pk,
      keyPackageRef: entry.kp_ref,
      isLastResort: entry.last_resort,
      publishedAt: entry.at,
      supportsGroupMetadata: true,
    }));
  }

  async storeJoinRequest(
    groupId: string,
    keyPackageAlias: string,
    coordinatorKey?: string,
  ): Promise<{ keyPackageRef: string; at: number }> {
    const keyPackage = this.requireKeyPackage(keyPackageAlias);
    await this.publishKeyPackage(keyPackageAlias, { coordinatorKey });
    const result = await this.getCoordinatorClient(
      coordinatorKey,
    ).StoreJoinRequest({
      gid: groupId,
      kp_ref: keyPackage.keyPackageRef,
    });
    return { keyPackageRef: keyPackage.keyPackageRef, at: result.at };
  }

  async fetchPendingJoinRequests(
    groupAlias: string,
  ): Promise<FetchPendingJoinRequestsOutput> {
    const group = this.getGroup(groupAlias);
    const groupId = this.deriveGroupId(group.state);
    return this.getGroupClient(group).FetchPendingJoinRequests({
      gid: groupId,
    });
  }

  async acceptWelcome(
    keyPackageReference: string,
    groupAlias?: string,
    coordinatorKey?: string,
  ): Promise<GroupSessionState> {
    await this.fetchWelcomes(coordinatorKey);
    const welcome = this.store.getWelcome(keyPackageReference);
    const keyPackage = this.store.findKeyPackageByRef(welcome.kp_ref);

    if (!keyPackage) {
      throw new MissingLocalKeyPackageForWelcomeError(welcome.kp_ref);
    }

    const alias = groupAlias ?? `group-${this.store.groupCount + 1}`;

    const group = await acceptStoredWelcome({
      keyPackageReference,
      groupAlias: alias,
      welcome,
      keyPackage,
      createGroupSessionState: (resolvedAlias, state) =>
        this.createGroupSessionState(
          resolvedAlias,
          state,
          this.resolveCoordinatorKey(coordinatorKey ?? welcome.coordinatorKey),
        ),
    });

    // Use the welcome cursor hint for efficient post-join sync.
    // If the inviter stored the commit cursor, skip messages sent
    // before the new member was added.
    if (welcome.after !== undefined && welcome.after > 0) {
      group.fetchCursor = welcome.after;
      group.lastCursor = welcome.after;
    }

    this.store.addGroup(group);
    await this.establishPostWelcomeBaseline(group, welcome.at);
    this.store.deleteWelcome(keyPackageReference);

    return this.getGroup(alias);
  }

  async sendMessage(
    groupAlias: string,
    content: string,
  ): Promise<StoredMessage> {
    return this.runGroupOperation(groupAlias, async () => {
      const group = this.getGroup(groupAlias);
      await this.catchUpGroupIfNeeded(group);
      this.assertGroupIsActive(group);

      const outbound = await createApplicationMessageBase64({
        state: group.state,
        event: createUnsignedCordnMessageEvent({
          pubkey: this.stablePubkey,
          content,
        }),
        authenticatedData: encodeAuthenticatedSender(this.stablePubkey),
      });

      group.state = outbound.newState;
      const posted = await this.postEncryptedGroupMessage(
        group,
        outbound.opaqueMessageBase64,
      );

      const stored: StoredMessage = {
        cursor: posted.cursor,
        createdAt: posted.at,
        direction: "outbound",
        sender: this.stablePubkey,
        id: outbound.event.id,
        kind: outbound.event.kind,
        tags: outbound.event.tags,
        content: outbound.event.content,
      };

      group.messages.push(stored);
      group.lastCursor = Math.max(group.lastCursor, posted.cursor);
      return stored;
    });
  }

  async syncGroup(groupAlias: string): Promise<StoredMessage[]> {
    if (this.isWatching(groupAlias)) {
      return [];
    }

    return this.runGroupOperation(groupAlias, async () => {
      const group = this.getGroup(groupAlias);
      const result = await this.fetchRawGroupMessages(
        this.deriveGroupId(group.state),
        group.fetchCursor,
      );
      const { received } = await this.applyIncomingMessages(
        group,
        result.messages,
      );
      return received;
    });
  }

  async watchGroup(groupAlias: string): Promise<void> {
    if (this.watchHandles.has(groupAlias)) {
      return;
    }

    const group = this.getGroup(groupAlias);
    const groupId = this.deriveGroupId(group.state);

    this.watchHandles.set(groupAlias, {
      abort: async () => undefined,
      task: Promise.resolve(),
      status: "connecting",
    });

    const watch = runGroupWatch({
      client: this.getGroupClient(group),
      groupId,
      getAfterCursor: () => group.fetchCursor,
      fetchMessages: async (afterCursor) => {
        const result = await this.fetchRawGroupMessages(groupId, afterCursor);
        return result.messages;
      },
      callbacks: {
        onConnecting: () => {
          this.setWatchStatus(groupAlias, "connecting");
        },
        onWatching: () => {
          this.setWatchStatus(groupAlias, "watching");
        },
        onMessages: async (messages) => {
          await this.runGroupOperation(groupAlias, async () => {
            const result = await this.applyIncomingMessages(group, messages);
            this.emitMessageEvent(groupAlias, result.received, result.issues);
          });
        },
      },
    });

    const task = watch.task.catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.setWatchStatus(groupAlias, "errored", reason);
      throw error;
    });

    const handle = this.watchHandles.get(groupAlias);
    if (handle) {
      handle.abort = watch.abort;
      handle.task = task;
    }
  }

  async unwatchGroup(groupAlias: string): Promise<void> {
    const handle = this.watchHandles.get(groupAlias);
    if (!handle) {
      return;
    }

    this.watchHandles.delete(groupAlias);
    await handle.abort("user requested stop").catch(() => undefined);
    await handle.task.catch(() => undefined);
    this.emitStatusEvent(groupAlias);
  }

  async watchAllGroups(): Promise<void> {
    for (const group of this.listGroups()) {
      await this.watchGroup(group.alias);
    }
  }

  async syncAll(): Promise<Record<string, StoredMessage[]>> {
    const entries = await Promise.all(
      this.listGroups()
        .filter((group) => group.status !== "removed")
        .map(
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

  private async postEncryptedGroupMessage(
    group: GroupSessionState,
    mlsMessageBase64: string,
  ): Promise<{
    cursor: number;
    at: number;
    gid: string;
    postedMsgBase64: string;
  }> {
    const gid = this.deriveGroupId(group.state);
    const mlsBytes = decodeBase64(mlsMessageBase64);
    const { encryptedBase64 } = await encryptGroupPayload({
      state: group.state,
      serializedMlsMessage: mlsBytes,
    });
    const result = await this.getGroupClient(group).PostGroupMessage({
      msg_64: encryptedBase64,
      gid,
    });
    return {
      cursor: result.cursor,
      at: result.at,
      gid: result.gid,
      postedMsgBase64: encryptedBase64,
    };
  }

  private async fetchRawGroupMessages(
    groupId: string,
    afterCursor: number,
  ): Promise<FetchGroupMessagesOutput> {
    const group = this.findGroupById(groupId);
    return this.getGroupClient(group).FetchGroupMessages({
      gid: groupId,
      after: this.toOptionalCursor(afterCursor),
    });
  }

  private createGroupSessionState(
    alias: string,
    state: ClientState,
    coordinatorKey: string,
  ): GroupSessionState {
    return {
      alias,
      coordinatorKey,
      state,
      metadata: getCordnGroupMetadataExtension(state),
      status: "active",
      lastCursor: 0,
      fetchCursor: 0,
      messages: [],
      syncIssues: [],
    };
  }

  private async runGroupOperation<T>(
    groupAlias: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.groupOperations.get(groupAlias) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lane = previous.catch(() => undefined).then(() => current);

    this.groupOperations.set(groupAlias, lane);

    await previous.catch(() => undefined);

    try {
      this.assertGroupIsActive(this.getGroup(groupAlias));

      return await operation();
    } finally {
      release();

      if (this.groupOperations.get(groupAlias) === lane) {
        this.groupOperations.delete(groupAlias);
      }
    }
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

  deriveGroupId(state: ClientState): string {
    return this.groupIdDecoder.decode(state.groupContext.groupId);
  }

  private findGroupById(groupId: string): GroupSessionState {
    const group = this.listGroups().find(
      (candidate) => this.deriveGroupId(candidate.state) === groupId,
    );

    if (!group) {
      throw new Error(`Unknown group for coordinator routing: ${groupId}`);
    }

    return group;
  }

  private resolveCoordinatorKey(coordinatorKey?: string): string {
    return coordinatorKey ?? this.coordinatorRegistry.defaultCoordinatorKey;
  }

  private getCoordinatorClient(coordinatorKey?: string) {
    return this.coordinatorRegistry.getClient(
      this.resolveCoordinatorKey(coordinatorKey),
    );
  }

  private getGroupClient(group: GroupSessionState) {
    return this.getCoordinatorClient(group.coordinatorKey);
  }

  private toOptionalCursor(cursor: number): number | undefined {
    return cursor > 0 ? cursor : undefined;
  }

  private assertGroupIsActive(group: GroupSessionState): void {
    if (
      group.status === "removed" ||
      group.state.groupActiveState.kind === "removedFromGroup"
    ) {
      group.status = "removed";
      throw new RemovedFromGroupError(group.alias);
    }
  }

  private adoptGroupState(group: GroupSessionState, state: ClientState): void {
    group.state = state;
    group.metadata = getCordnGroupMetadataExtension(state);
  }

  private async catchUpGroupIfNeeded(group: GroupSessionState): Promise<void> {
    if (this.isWatching(group.alias)) {
      return;
    }

    const result = await this.fetchRawGroupMessages(
      this.deriveGroupId(group.state),
      group.fetchCursor,
    );
    await this.applyIncomingMessages(group, result.messages);
  }

  /**
   * Find a pending epoch operation whose posted encrypted wrapper matches
   * the raw msg_64.  Used to detect self-echos of commits that were sealed
   * with the pre-commit exporter secret before the session adopted the
   * new epoch state.
   */
  private findPendingOpByPostedMsg(
    pendingEpochOperations: Map<string, PendingEpochOperation[]>,
    groupAlias: string,
    postedMsgBase64: string,
  ): PendingEpochOperation | undefined {
    const pending = pendingEpochOperations.get(groupAlias);
    if (!pending || pending.length === 0) {
      return undefined;
    }
    return pending.find((op) => op.postedMsgBase64 === postedMsgBase64);
  }

  private async applyIncomingMessages(
    group: GroupSessionState,
    messages: FetchGroupMessagesOutput["messages"],
    options: {
      suppressIssue?: (issue: SyncIssue) => boolean;
      finalizePendingOperations?: boolean;
      recordReceivedMessages?: boolean;
    } = {},
  ): Promise<{
    received: StoredMessage[];
    issues: SyncIssue[];
  }> {
    // Process messages one-at-a-time so that state-advancing commits
    // update the exporter secret before subsequent messages from the
    // new epoch are decrypted.
    const previousMessageCount = group.messages.length;
    const allReceived: StoredMessage[] = [];
    const allIssues: SyncIssue[] = [];
    const allAppliedPending = new Set<string>();
    const allRejectedPending = new Set<string>();

    const pendingOps = this.store.pendingOperations;

    for (const message of messages) {
      let opaqueMessageBase64: string;

      if (message.encrypted) {
        // Self-echo detection: commits are encrypted with the pre-commit
        // state so all members can decrypt them.  The creator adopts the
        // new state immediately after posting and can no longer decrypt
        // the echo, so we match the posted encrypted wrapper against
        // pending operations instead.
        const pendingOp = this.findPendingOpByPostedMsg(
          pendingOps,
          group.alias,
          message.msg_64,
        );
        if (pendingOp) {
          opaqueMessageBase64 = pendingOp.commitMessageBase64;
        } else {
          try {
            const { serializedMlsMessage } = await decryptGroupPayload({
              state: group.state,
              encryptedBase64: message.msg_64,
            });
            opaqueMessageBase64 = encodeBase64(serializedMlsMessage);
          } catch {
            // Skip messages from epochs we have not joined — decryption
            // fails naturally because the exporter secret differs.
            // Advance the cursor so we do not re-fetch the same
            // undecryptable message on every sync (e.g. pre-join traffic
            // when a Welcome lacks an `after` hint).
            group.fetchCursor = Math.max(group.fetchCursor, message.cursor);
            group.lastCursor = Math.max(group.lastCursor, message.cursor);
            continue;
          }
        }
      } else {
        opaqueMessageBase64 = message.msg_64;
      }

      // Ingest this single message immediately so that epoch-advancing
      // commits update group.state before the next message is decrypted.
      const sync = await ingestGroupMessages({
        group,
        messages: [
          {
            cursor: message.cursor,
            createdAt: message.at,
            opaqueMessageBase64,
          },
        ],
        getPendingEpochOperation: (opaque: string) =>
          getPendingEpochOperation(pendingOps, group.alias, opaque),
        localStablePubkey: this.stablePubkey,
      });

      if (options.recordReceivedMessages !== false) {
        allReceived.push(...sync.received);
      }
      allIssues.push(...sync.issues);
      for (const m of sync.appliedPendingCommitMessages) {
        allAppliedPending.add(m);
      }
      for (const m of sync.rejectedPendingCommitMessages) {
        allRejectedPending.add(m);
      }

      if (sync.removedLocalMember && this.isWatching(group.alias)) {
        queueMicrotask(() => {
          void this.unwatchGroup(group.alias).catch(() => undefined);
        });
      }
    }

    if (options.recordReceivedMessages === false) {
      group.messages.splice(previousMessageCount);
    }

    // Only mark (don't finalize) when the caller asks for deferred
    // finalization (e.g. during catch-up before a group operation).
    if (options.finalizePendingOperations === false) {
      if (allAppliedPending.size > 0) {
        markPendingEpochOperationsConfirmed(this.store.pendingOperations, {
          groupAlias: group.alias,
          opaqueMessageBase64s: [...allAppliedPending],
        });
      }
    } else {
      if (allAppliedPending.size > 0) {
        await confirmPendingEpochOperations(
          this.store.pendingOperations,
          this.getGroupClient(group),
          {
            groupAlias: group.alias,
            opaqueMessageBase64s: [...allAppliedPending],
          },
        );
        await this.fetchWelcomes();
      }

      if (allRejectedPending.size > 0) {
        await rejectPendingEpochOperations(this.store.pendingOperations, {
          groupAlias: group.alias,
          opaqueMessageBase64s: [...allRejectedPending],
        });
      }
    }

    return {
      received: allReceived,
      issues: options.suppressIssue
        ? this.removeSuppressedIssues(
            group,
            group.syncIssues.length - allIssues.length,
            options.suppressIssue,
          )
        : allIssues,
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
      recordReceivedMessages: false,
      suppressIssue: (issue) =>
        issue.createdAt <= welcomeCreatedAt &&
        (issue.detail ===
          "Cannot process commit or proposal from former epoch" ||
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
    this.emitStatusEvent(groupAlias);
  }

  private emitStatusEvent(groupAlias: string): void {
    const handle = this.watchHandles.get(groupAlias);
    const event: GroupEvent = {
      type: "watch-status-changed",
      groupAlias,
      watchStatus: handle?.status ?? "idle",
      error: handle?.lastError,
    };

    for (const listener of this.groupEventListeners) {
      listener(event);
    }
  }

  private emitMessageEvent(
    groupAlias: string,
    received: StoredMessage[],
    issues: SyncIssue[],
  ): void {
    const handle = this.watchHandles.get(groupAlias);
    const event: GroupEvent = {
      type: "messages-ingested",
      groupAlias,
      received,
      issues,
      watchStatus: handle?.status ?? "idle",
      error: handle?.lastError,
    };

    for (const listener of this.groupEventListeners) {
      listener(event);
    }
  }
}
