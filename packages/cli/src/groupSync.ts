import {
  createAdminAuthorizationCallback,
  createUnauthorizedAdminRejectionDetail,
} from "./adminPolicy.ts";
import type { IncomingMessageCallback } from "ts-mls";
import type { PendingEpochOperation } from "./pendingEpochOperations.ts";
import { getCordnGroupMetadataExtension } from "@cordn/core";
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

function isUndecryptableStaleMessageIssue(detail: string): boolean {
  return detail.startsWith("OperationError: The operation failed");
}

function wasMessageRejectedByCallback(result: {
  kind: "newState";
  actionTaken?: string;
}): boolean {
  return result.actionTaken === "reject";
}

/**
 * Compatibility shim: ts-mls may throw this when processing a commit
 * that removed the local member before surfacing the structured
 * "removedFromGroup" state. Treat it as a removal signal.
 */
function isRemovedMemberCommitIssue(detail: string): boolean {
  return (
    detail === "Could not find common ancestor" ||
    detail ===
      "This error should never occur, if you see this please submit a bug report. Message: No overlap between provided private keys and update path"
  );
}

function isRemovedFromGroupState(state: GroupSessionState["state"]): boolean {
  return state.groupActiveState?.kind === "removedFromGroup";
}

/**
 * Wraps an admin-authorization callback so it also captures the sender leaf
 * index of any Commit. ts-mls fires the callback before applying the commit's
 * update path (processMessages.js:158 vs :249), so even when path application
 * throws (the sibling-Commit case) the sender is already captured. Used by the
 * multi-device sibling-skip (spec/applications/multi-device.md §10).
 */
function wrapCallbackWithSenderCapture(
  inner: IncomingMessageCallback | undefined,
  capture: { leafIndex?: number },
): IncomingMessageCallback {
  return (incoming) => {
    if (incoming.kind === "commit") {
      capture.leafIndex = incoming.senderLeafIndex;
    }
    return inner ? inner(incoming) : "accept";
  };
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

    if (isPendingOperationMessage) {
      group.fetchCursor = message.cursor;
      group.lastCursor = Math.max(group.lastCursor, message.cursor);
      appliedPendingCommitMessages.add(message.opaqueMessageBase64);
      continue;
    }

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

    // Capture the Commit sender's leaf index via the callback so the
    // sibling-skip below can tell a sibling Commit (my own shared leaf) from
    // a genuine removal. See spec/applications/multi-device.md §10.
    const senderCapture: { leafIndex?: number } = {};

    try {
      processed = await processMessageBase64({
        state: group.state,
        opaqueMessageBase64: message.opaqueMessageBase64,
        callback: wrapCallbackWithSenderCapture(
          createAdminAuthorizationCallback({
            state: group.state,
            metadata: group.metadata,
          }),
          senderCapture,
        ),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      if (
        isFormerEpochIssue(detail) ||
        isStaleGenerationIssue(detail) ||
        isUndecryptableStaleMessageIssue(detail) ||
        isRemovedMemberCommitIssue(detail)
      ) {
        group.fetchCursor = message.cursor;
        group.lastCursor = Math.max(group.lastCursor, message.cursor);

        if (
          pendingOperation !== undefined &&
          (isRemovedMemberCommitIssue(detail) || isFormerEpochIssue(detail))
        ) {
          appliedPendingCommitMessages.add(message.opaqueMessageBase64);
        } else if (
          isRemovedMemberCommitIssue(detail) &&
          !isPendingOperationMessage
        ) {
          // Multi-device sibling-skip (spec/applications/multi-device.md
          // §10): a Commit from a sibling device (same shared leaf) cannot
          // be ingested from the stream — the update path refreshed our
          // shared leaf with keys only the sibling holds. The captured
          // sender leaf index equals our own, so this is not a genuine
          // removal. Skip the Commit (cursor already advanced above) and
          // converge via the session document fast-forward. Application
          // messages and third-party Commits never reach this branch.
          const myLeafIndex = findMemberLeafIndexByStablePubkey(
            group.state,
            localStablePubkey,
          );
          if (
            senderCapture.leafIndex !== undefined &&
            myLeafIndex >= 0 &&
            senderCapture.leafIndex === myLeafIndex
          ) {
            continue;
          }
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

    if (
      processed.kind === "newState" &&
      wasMessageRejectedByCallback(processed)
    ) {
      const issue = {
        cursor: message.cursor,
        createdAt: message.createdAt,
        detail: createUnauthorizedAdminRejectionDetail({
          groupAlias: group.alias,
        }),
      };
      group.fetchCursor = message.cursor;
      group.lastCursor = Math.max(group.lastCursor, message.cursor);
      if (isPendingOperationMessage) {
        rejectedPendingCommitMessages.add(message.opaqueMessageBase64);
      }
      group.syncIssues.push(issue);
      issues.push(issue);
      continue;
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
    appliedPendingCommitMessages,
    rejectedPendingCommitMessages,
    removedLocalMember,
  };
}
