import type { cordnClient } from "./coordinatorClient.ts";

export type PendingEpochOperation =
  | PendingAddMemberOperation
  | PendingRemoveMemberOperation;

export interface PendingEpochOperationBase {
  kind: PendingEpochOperationKind;
  groupAlias: string;
  groupId: string;
  commitMessageBase64: string;
  status: PendingEpochOperationStatus;
}

export type PendingEpochOperationKind = "add-member" | "remove-member";

export type PendingEpochOperationStatus = "pending" | "confirmed" | "rejected";

export interface PendingAddMemberOperation extends PendingEpochOperationBase {
  kind: "add-member";
  keyPackageReference: string;
  targetStablePubkey: string;
  welcomeBase64: string;
}

export interface PendingRemoveMemberOperation extends PendingEpochOperationBase {
  kind: "remove-member";
  targetStablePubkey: string;
}

export interface PendingEpochOperationFinalizerContext {
  client: cordnClient;
}

type PendingEpochOperationFinalizer = (
  operation: PendingEpochOperation,
  context: PendingEpochOperationFinalizerContext,
) => Promise<void>;

const pendingEpochOperationFinalizers: Record<
  PendingEpochOperationKind,
  PendingEpochOperationFinalizer
> = {
  "add-member": async (operation, context) => {
    if (operation.kind !== "add-member") {
      throw new Error("Expected add-member pending operation");
    }

    await context.client.StoreWelcome({
      target_pk: operation.targetStablePubkey,
      kp_ref: operation.keyPackageReference,
      welcome_64: operation.welcomeBase64,
    });
  },
  "remove-member": async () => undefined,
};

async function finalizePendingEpochOperation(
  operation: PendingEpochOperation,
  context: PendingEpochOperationFinalizerContext,
): Promise<void> {
  await pendingEpochOperationFinalizers[operation.kind](operation, context);
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
): Promise<void> {
  const pending = pendingEpochOperations.get(params.groupAlias);

  if (!pending || pending.length === 0) {
    return;
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

  const remaining: PendingEpochOperation[] = [];

  for (const operation of pending) {
    if (operation.status === "confirmed") {
      await finalizePendingEpochOperation(operation, { client });
      continue;
    }

    remaining.push(operation);
  }

  if (remaining.length === 0) {
    pendingEpochOperations.delete(params.groupAlias);
    return;
  }

  pendingEpochOperations.set(params.groupAlias, remaining);
}

export function markPendingEpochOperationsConfirmed(
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

  const { matched } = partitionPendingEpochOperations(
    pending,
    params.opaqueMessageBase64s,
  );

  for (const operation of matched) {
    operation.status = "confirmed";
  }
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

export async function rejectPendingEpochOperations(
  pendingEpochOperations: Map<string, PendingEpochOperation[]>,
  params: {
    groupAlias: string;
    opaqueMessageBase64s: string[];
  },
): Promise<void> {
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
