/**
 * Structured classification of ts-mls `processMessage` failures.
 *
 * This module is the SINGLE place that inspects ts-mls error message strings.
 * It replaces the four string-matching classifiers that lived in
 * `packages/cli/src/groupSync.ts` (`isFormerEpochIssue`, `isStaleGenerationIssue`,
 * `isUndecryptableStaleMessageIssue`, `isRemovedMemberCommitIssue`). Callers
 * receive typed dispositions instead of fragile regexes scattered across app code.
 *
 * ponytail: the strings are ts-mls-version-specific; we contain that fragility
 * here. If ts-mls later exposes structured error codes, swap this one function.
 */
export type ProcessErrorClass =
  | "formerEpoch"
  | "staleGeneration"
  | "undecryptable"
  | "ratchetTreeInvariant"
  | "removalCommit";

export interface ClassifiedProcessError {
  cls: ProcessErrorClass;
  message: string;
}

export function classifyProcessError(
  error: unknown,
): ClassifiedProcessError | undefined {
  const detail = error instanceof Error ? error.message : String(error);

  if (
    detail === "Cannot process commit or proposal from former epoch" ||
    detail === "Cannot process message, epoch too old"
  ) {
    return { cls: "formerEpoch", message: detail };
  }

  if (detail === "Desired gen in the past") {
    return { cls: "staleGeneration", message: detail };
  }

  if (detail.startsWith("OperationError: The operation failed")) {
    return { cls: "undecryptable", message: detail };
  }

  // Battle-tested in the web app (chatGroupMessages.ts: isRatchetTreeInvariantIssue):
  // a structural ratchet-tree invariant violation. Benign in cordn (the DS
  // orders commits); advance past it like the other soft errors.
  if (
    detail.includes(
      "non-blank intermediate node must list leaf node in its unmerged_leaves",
    )
  ) {
    return { cls: "ratchetTreeInvariant", message: detail };
  }

  if (
    detail === "Could not find common ancestor" ||
    detail ===
      "This error should never occur, if you see this please submit a bug report. Message: No overlap between provided private keys and update path"
  ) {
    return { cls: "removalCommit", message: detail };
  }

  return undefined;
}
