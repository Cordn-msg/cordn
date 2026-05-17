import type { PendingEpochOperation } from "./pendingEpochOperations.ts";
import { getCordnGroupMetadataExtension } from "./groupMetadata.ts";
import { decodeCordnMessageEvent } from "./messageEnvelope.ts";
import type { GroupSessionState, StoredMessage } from "./sessionState.ts";
import {
  decodeAuthenticatedSender,
  processMessageBase64,
} from "./utils/mlsMessages.ts";
import { findMemberLeafIndexByStablePubkey } from "./utils/mlsGroupLifecycle.ts";

export interface RawGroupMessage {
  cursor: number;
  createdAt: number;
  opaqueMessageBase64: string;
}

export interface GroupIngestionResult {
  received: StoredMessage[];
  issues: GroupSessionState["syncIssues"];
  cursorAdvancedTo: number;
  appliedPendingCommitMessages: Set<string>;
  rejectedPendingCommitMessages: Set<string>;
  removedLocalMember: boolean;
}

function isFormerEpochIssue(detail: string): boolean {
  return (
    detail === "Cannot process commit or proposal from former epoch" ||
    detail === "Cannot process message, epoch too old"
  );
}

function isStaleGenerationIssue(detail: string): boolean {
  return detail === "Desired gen in the past";
}

function isRemovedMemberCommitIssue(detail: string): boolean {
  return detail === "Could not find common ancestor";
}

function isRemovedFromGroupState(state: GroupSessionState["state"]): boolean {
  return state.groupActiveState?.kind === "removedFromGroup";
}

export async function ingestGroupMessages(params: {
  group: GroupSessionState;
  messages: RawGroupMessage[];
  getPendingEpochOperation: (
    opaqueMessageBase64: string,
  ) => PendingEpochOperation | undefined;
  localStablePubkey: string;
}): Promise<GroupIngestionResult> {
  const { group, messages, getPendingEpochOperation, localStablePubkey } =
    params;
  const received: StoredMessage[] = [];
  const issues: GroupSessionState["syncIssues"] = [];
  const appliedPendingCommitMessages = new Set<string>();
  const rejectedPendingCommitMessages = new Set<string>();
  let removedLocalMember = false;

  for (const message of messages) {
    const pendingOperation = getPendingEpochOperation(
      message.opaqueMessageBase64,
    );
    const isPendingOperationMessage = pendingOperation !== undefined;

    if (
      !isPendingOperationMessage &&
      group.messages.some(
        (stored) =>
          stored.direction === "outbound" && stored.cursor === message.cursor,
      )
    ) {
      group.fetchCursor = message.cursor;
      group.lastCursor = Math.max(group.lastCursor, message.cursor);
      continue;
    }

    let processed: Awaited<ReturnType<typeof processMessageBase64>>;

    try {
      processed = await processMessageBase64({
        state: group.state,
        opaqueMessageBase64: message.opaqueMessageBase64,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      if (
        isFormerEpochIssue(detail) ||
        isStaleGenerationIssue(detail) ||
        isRemovedMemberCommitIssue(detail)
      ) {
        group.fetchCursor = message.cursor;
        group.lastCursor = Math.max(group.lastCursor, message.cursor);

        if (
          pendingOperation?.kind === "remove-member" &&
          (isRemovedMemberCommitIssue(detail) || isFormerEpochIssue(detail))
        ) {
          appliedPendingCommitMessages.add(message.opaqueMessageBase64);
        } else if (
          isRemovedMemberCommitIssue(detail) &&
          !isPendingOperationMessage
        ) {
          group.status = "removed";
          group.removedAtCursor = message.cursor;
          removedLocalMember = true;
        } else {
          if (isPendingOperationMessage) {
            rejectedPendingCommitMessages.add(message.opaqueMessageBase64);
          }

          const issue = {
            cursor: message.cursor,
            createdAt: message.createdAt,
            detail,
          };
          group.syncIssues.push(issue);
          issues.push(issue);
        }

        continue;
      }

      throw error;
    }

    if (processed.kind === "applicationMessage") {
      group.state = processed.newState;
      group.metadata = getCordnGroupMetadataExtension(processed.newState);
      if (isRemovedFromGroupState(processed.newState)) {
        group.status = "removed";
        group.removedAtCursor = message.cursor;
        removedLocalMember = true;
        group.fetchCursor = message.cursor;
        group.lastCursor = Math.max(group.lastCursor, message.cursor);
        continue;
      }
      if (processed.aad.length === 0) {
        throw new Error(
          "Cordn application message missing authenticated sender",
        );
      }

      const sender = decodeAuthenticatedSender(processed.aad);
      const event = decodeCordnMessageEvent(processed.message);
      if (event.pubkey !== sender) {
        throw new Error("Cordn message envelope pubkey does not match sender");
      }

      const stored: StoredMessage = {
        cursor: message.cursor,
        createdAt: message.createdAt,
        direction: "inbound",
        sender,
        id: event.id,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
      };

      group.messages.push(stored);
      group.fetchCursor = message.cursor;
      group.lastCursor = Math.max(group.lastCursor, message.cursor);
      received.push(stored);
      continue;
    }

    group.fetchCursor = message.cursor;
    group.lastCursor = Math.max(group.lastCursor, message.cursor);

    if (isPendingOperationMessage) {
      appliedPendingCommitMessages.add(message.opaqueMessageBase64);
    }

    if (processed.kind !== "newState") {
      continue;
    }

    group.state = processed.newState;
    group.metadata = getCordnGroupMetadataExtension(processed.newState);

    if (
      isRemovedFromGroupState(processed.newState) ||
      findMemberLeafIndexByStablePubkey(processed.newState, localStablePubkey) <
        0
    ) {
      group.status = "removed";
      group.removedAtCursor = message.cursor;
      removedLocalMember = true;
    }
  }

  return {
    received,
    issues,
    cursorAdvancedTo: group.fetchCursor,
    appliedPendingCommitMessages,
    rejectedPendingCommitMessages,
    removedLocalMember,
  };
}
