import { getCordnGroupMetadataExtension } from "./groupMetadata.ts";
import type { GroupSessionState, StoredMessage } from "./sessionState.ts";
import {
  decodeApplicationData,
  decodeAuthenticatedSender,
  processMessageBase64,
} from "./utils/mlsMessages.ts";

export interface RawGroupMessage {
  cursor: number;
  createdAt: number;
  opaqueMessageBase64: string;
}

export interface GroupSyncResult {
  received: StoredMessage[];
  appliedPendingCommitMessages: Set<string>;
  rejectedPendingCommitMessages: Set<string>;
}

export async function applyGroupSync(params: {
  group: GroupSessionState;
  messages: RawGroupMessage[];
  hasPendingEpochOperation: (opaqueMessageBase64: string) => boolean;
}): Promise<GroupSyncResult> {
  const { group, messages, hasPendingEpochOperation } = params;
  const received: StoredMessage[] = [];
  const appliedPendingCommitMessages = new Set<string>();
  const rejectedPendingCommitMessages = new Set<string>();

  for (const message of messages) {
    const isPendingOperationMessage = hasPendingEpochOperation(
      message.opaqueMessageBase64,
    );

    if (
      group.messages.some(
        (stored) =>
          stored.cursor === message.cursor && stored.direction === "outbound",
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
        detail === "Cannot process commit or proposal from former epoch" ||
        detail === "Cannot process message, epoch too old"
      ) {
        group.fetchCursor = message.cursor;
        group.lastCursor = Math.max(group.lastCursor, message.cursor);
        group.syncIssues.push({
          cursor: message.cursor,
          createdAt: message.createdAt,
          detail,
        });

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
    appliedPendingCommitMessages,
    rejectedPendingCommitMessages,
  };
}
