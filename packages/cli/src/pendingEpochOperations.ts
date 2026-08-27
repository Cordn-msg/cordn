import type { cordnClient } from "./coordinatorClient.ts";

export type PendingEpochOperation =
  | PendingAddMemberOperation
  | PendingRemoveMemberOperation
  | PendingUpdateGroupMetadataOperation;

export interface PendingEpochOperationBase {
  kind: PendingEpochOperationKind;
  groupAlias: string;
  groupId: string;
  commitMessageBase64: string;
  /** The encrypted wrapper that was posted to the coordinator.
   *  Used to match self-echos before decryption so the creator
   *  can confirm the operation even after adopting the new state. */
  postedMsgBase64?: string;
  /** False while PostGroupMessage is unresolved. If a restart observes the
   *  self-echo from this state, it must apply the Commit instead of assuming
   *  the post-Commit ClientState was already adopted. Older snapshots omit it
   *  and therefore retain the historical "already applied" behavior. */
  localStateApplied?: boolean;
  status: PendingEpochOperationStatus;
}

export type PendingEpochOperationKind =
  | "add-member"
  | "remove-member"
  | "update-group-metadata";

export type PendingEpochOperationStatus = "pending" | "confirmed" | "rejected";

export interface PendingAddMemberOperation extends PendingEpochOperationBase {
  kind: "add-member";
  keyPackageReference: string;
  targetStablePubkey: string;
  welcomeBase64: string;
  /** Cursor at which the commit adding this member was posted.
   *  Stored in the welcome so the invitee can initialize their
   *  fetch cursor and skip pre-join messages. */
  joinAfterCursor?: number;
}

export interface PendingRemoveMemberOperation extends PendingEpochOperationBase {
  kind: "remove-member";
  targetStablePubkey: string;
}

export interface PendingUpdateGroupMetadataOperation extends PendingEpochOperationBase {
  kind: "update-group-metadata";
}

async function finalizePendingEpochOperation(
  operation: PendingEpochOperation,
  client: cordnClient,
): Promise<void> {
  if (operation.kind !== "add-member") return;
  await client.StoreWelcome({
    target_pk: operation.targetStablePubkey,
    kp_ref: operation.keyPackageReference,
    welcome_64: operation.welcomeBase64,
    after: operation.joinAfterCursor,
  });
}

function partitionPendingEpochOperations(
  pending: PendingEpochOperation[],
  opaqueMessageBase64s: string[],
): {
  matched: PendingEpochOperation[];
  remaining: PendingEpochOperation[];
} {
  const seen = new Set(opaqueMessageBase64s);

  return {
    matched: pending.filter((operation) =>
      seen.has(operation.commitMessageBase64),
    ),
    remaining: pending.filter(
      (operation) => !seen.has(operation.commitMessageBase64),
    ),
  };
}

export function enqueuePendingEpochOperation(
  pendingEpochOperations: Map<string, PendingEpochOperation[]>,
  operation: PendingEpochOperation,
): void {
  const existing = pendingEpochOperations.get(operation.groupAlias) ?? [];
  existing.push(operation);
  pendingEpochOperations.set(operation.groupAlias, existing);
}

export async function confirmPendingEpochOperations(
  pendingEpochOperations: Map<string, PendingEpochOperation[]>,
  client: cordnClient,
  params: {
    groupAlias: string;
    opaqueMessageBase64s: string[];
  },
): Promise<number> {
  const pending = pendingEpochOperations.get(params.groupAlias);

  if (!pending || pending.length === 0) {
    return 0;
  }

  if (params.opaqueMessageBase64s.length > 0) {
    const { matched } = partitionPendingEpochOperations(
      pending,
      params.opaqueMessageBase64s,
    );

    for (const operation of matched) {
      operation.status = "confirmed";
    }
  }

  let finalized = 0;
  for (const operation of [...pending]) {
    if (operation.status !== "confirmed") continue;
    await finalizePendingEpochOperation(operation, client);
    // Commit each successful finalizer immediately. If a later Welcome fails,
    // retry only that one rather than duplicating records already stored.
    const remaining = (
      pendingEpochOperations.get(params.groupAlias) ?? []
    ).filter((candidate) => candidate !== operation);
    if (remaining.length === 0) {
      pendingEpochOperations.delete(params.groupAlias);
    } else {
      pendingEpochOperations.set(params.groupAlias, remaining);
    }
    finalized += 1;
  }
  return finalized;
}

export function getPendingEpochOperation(
  pendingEpochOperations: Map<string, PendingEpochOperation[]>,
  groupAlias: string,
  opaqueMessageBase64: string,
): PendingEpochOperation | undefined {
  const pending = pendingEpochOperations.get(groupAlias);

  if (!pending || pending.length === 0) {
    return undefined;
  }

  return pending.find(
    (operation) => operation.commitMessageBase64 === opaqueMessageBase64,
  );
}

export function dropPendingAddMemberForTarget(
  pendingEpochOperations: Map<string, PendingEpochOperation[]>,
  groupAlias: string,
  targetStablePubkey: string,
): void {
  const pending = pendingEpochOperations.get(groupAlias);
  if (!pending?.length) return;
  const remaining = pending.filter(
    (operation) =>
      operation.kind !== "add-member" ||
      operation.targetStablePubkey !== targetStablePubkey,
  );
  if (remaining.length === 0) pendingEpochOperations.delete(groupAlias);
  else pendingEpochOperations.set(groupAlias, remaining);
}

export function rejectPendingEpochOperations(
  pendingEpochOperations: Map<string, PendingEpochOperation[]>,
  params: {
    groupAlias: string;
    opaqueMessageBase64s: string[];
  },
): void {
  const pending = pendingEpochOperations.get(params.groupAlias);

  if (
    !pending ||
    pending.length === 0 ||
    params.opaqueMessageBase64s.length === 0
  ) {
    return;
  }

  const { matched: rejected, remaining } = partitionPendingEpochOperations(
    pending,
    params.opaqueMessageBase64s,
  );

  for (const operation of rejected) {
    operation.status = "rejected";
  }

  if (remaining.length === 0) {
    pendingEpochOperations.delete(params.groupAlias);
    return;
  }

  pendingEpochOperations.set(params.groupAlias, remaining);
}
