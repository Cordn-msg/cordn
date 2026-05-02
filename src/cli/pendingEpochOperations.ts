import type { cordnClient } from "./coordinatorClient.ts";

export type PendingEpochOperation = PendingAddMemberOperation;

export interface PendingEpochOperationBase {
  kind: PendingEpochOperationKind;
  groupAlias: string;
  groupId: string;
  commitMessageBase64: string;
  status: PendingEpochOperationStatus;
}

export type PendingEpochOperationKind = "add-member";

export type PendingEpochOperationStatus = "pending" | "confirmed" | "rejected";

export interface PendingAddMemberOperation extends PendingEpochOperationBase {
  kind: "add-member";
  keyPackageReference: string;
  targetStablePubkey: string;
  welcomeBase64: string;
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
    await context.client.StoreWelcome({
      targetStablePubkey: operation.targetStablePubkey,
      keyPackageReference: operation.keyPackageReference,
      welcomeBase64: operation.welcomeBase64,
    });
  },
};

async function finalizePendingEpochOperation(
  operation: PendingEpochOperation,
  context: PendingEpochOperationFinalizerContext,
): Promise<void> {
  await pendingEpochOperationFinalizers[operation.kind](operation, context);
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

  if (
    !pending ||
    pending.length === 0 ||
    params.opaqueMessageBase64s.length === 0
  ) {
    return;
  }

  const seen = new Set(params.opaqueMessageBase64s);

  const confirmed = pending.filter((operation) =>
    seen.has(operation.commitMessageBase64),
  );

  const remaining = pending.filter(
    (operation) => !seen.has(operation.commitMessageBase64),
  );

  for (const operation of confirmed) {
    await finalizePendingEpochOperation(operation, { client });
    operation.status = "confirmed";
  }

  if (remaining.length === 0) {
    pendingEpochOperations.delete(params.groupAlias);
    return;
  }

  pendingEpochOperations.set(params.groupAlias, remaining);
}

export function hasPendingEpochOperation(
  pendingEpochOperations: Map<string, PendingEpochOperation[]>,
  groupAlias: string,
  opaqueMessageBase64: string,
): boolean {
  const pending = pendingEpochOperations.get(groupAlias);

  if (!pending || pending.length === 0) {
    return false;
  }

  return pending.some(
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

  const rejected = new Set(params.opaqueMessageBase64s);

  const remaining = pending.filter(
    (operation) => !rejected.has(operation.commitMessageBase64),
  );

  for (const operation of pending) {
    if (rejected.has(operation.commitMessageBase64)) {
      operation.status = "rejected";
    }
  }

  if (remaining.length === 0) {
    pendingEpochOperations.delete(params.groupAlias);
    return;
  }

  pendingEpochOperations.set(params.groupAlias, remaining);
}
