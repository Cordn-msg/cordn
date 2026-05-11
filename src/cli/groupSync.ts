import { getCordnGroupMetadataExtension } from "./groupMetadata.ts";
import { decodeCordnMessageEvent } from "./messageEnvelope.ts";
import type { GroupSessionState, StoredMessage } from "./sessionState.ts";
import {
  decodeAuthenticatedSender,
  processMessageBase64,
} from "./utils/mlsMessages.ts";

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

export async function ingestGroupMessages(params: {
  group: GroupSessionState;
  messages: RawGroupMessage[];
  hasPendingEpochOperation: (opaqueMessageBase64: string) => boolean;
}): Promise<GroupIngestionResult> {
  const { group, messages, hasPendingEpochOperation } = params;
  const received: StoredMessage[] = [];
  const issues: GroupSessionState["syncIssues"] = [];
  const appliedPendingCommitMessages = new Set<string>();
  const rejectedPendingCommitMessages = new Set<string>();

  for (const message of messages) {
    const isPendingOperationMessage = hasPendingEpochOperation(
      message.opaqueMessageBase64,
    );

    if (
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

      if (isFormerEpochIssue(detail) || isStaleGenerationIssue(detail)) {
        group.fetchCursor = message.cursor;
        group.lastCursor = Math.max(group.lastCursor, message.cursor);
        const issue = {
          cursor: message.cursor,
          createdAt: message.createdAt,
          detail,
        };
        group.syncIssues.push(issue);
        issues.push(issue);

        if (isPendingOperationMessage) {
          rejectedPendingCommitMessages.add(message.opaqueMessageBase64);
        }

        continue;
      }

      throw error;
    }

    if (processed.kind === "applicationMessage") {
      group.state = processed.newState;
      group.metadata = getCordnGroupMetadataExtension(processed.newState);
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

    if (processed.kind !== "newState") {
      continue;
    }

    group.state = processed.newState;
    group.metadata = getCordnGroupMetadataExtension(processed.newState);

    if (isPendingOperationMessage) {
      appliedPendingCommitMessages.add(message.opaqueMessageBase64);
    }
  }

  return {
    received,
    issues,
    cursorAdvancedTo: group.fetchCursor,
    appliedPendingCommitMessages,
    rejectedPendingCommitMessages,
  };
}
