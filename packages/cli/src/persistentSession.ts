import { CliSession } from "./session.ts";
import type { CliSessionSnapshot } from "./session.ts";
import type { CliSessionOptions } from "./sessionState.ts";
import type { MediaStore } from "./mediaStore.ts";
import type { TransportEncryption } from "./coordinatorClient.ts";
import {
  acquireStateLock,
  loadEncryptedState,
  saveEncryptedState,
} from "./localState.ts";
import { DEFAULT_COORDINATOR_PUBKEY, DEFAULT_RELAY_URLS } from "./defaults.ts";

export interface OpenPersistentSessionOptions {
  /**
   * Encrypted snapshot path; the process becomes its sole writer. Omit for an
   * ephemeral in-memory session (nothing is locked or saved).
   */
  stateFile?: string;
  /** Hex-encoded 32-byte state key file; defaults to `${stateFile}.key`. */
  stateKeyFile?: string;
  /** Identity for a fresh state file; must match the stored identity otherwise. */
  privateKey?: string;
  /** Explicit coordinator; wins over the snapshot's saved default. */
  serverPubkey?: string;
  /** Explicit relays; win over the snapshot's saved relays. */
  relays?: string[];
  /**
   * Used only when neither the options nor the snapshot supply a value. The
   * CLI passes env-derived values here; library callers usually omit it.
   */
  fallback?: { serverPubkey?: string; relays?: string[] };
  mediaStore?: MediaStore;
  /**
   * Coordinator request transport. "required" gift-wraps every request so
   * relays see neither the method nor the group id, and lets the transport
   * de-duplicate a request relayed more than once. Default "disabled".
   */
  transportEncryption?: TransportEncryption;
  onLocalStateAdvance?: CliSessionOptions["onLocalStateAdvance"];
}

export interface PersistentSession {
  session: CliSession;
  /** True when an existing snapshot was restored. */
  restored: boolean;
  /**
   * Queue a durable snapshot write. `beforeSave` runs inside the same
   * serialized queue, before the snapshot is exported, so side effects that
   * must become durable before the cursor advances (inbox files) go there.
   * The first failed write is sticky: later calls reject immediately.
   */
  persist(beforeSave?: () => Promise<void>): Promise<void>;
  /** First durability failure, if any. */
  readonly durabilityError: unknown;
  /** Wait for every queued write to settle without rejecting. */
  flush(): Promise<void>;
  /**
   * Stop live ingestion, take a final snapshot (unless durability already
   * failed), and release the state lock. Safe to call once.
   */
  close(): Promise<void>;
}

/**
 * Open (or create) a persistent `CliSession` backed by an encrypted state file:
 * exclusive lock, snapshot restore, identity check, coordinator/relay
 * precedence, and a serialized durable-write queue. This is the exact wiring
 * the `cordn` daemon uses; library consumers get the same guarantees.
 */
export async function openPersistentSession(
  options: OpenPersistentSessionOptions,
): Promise<PersistentSession> {
  const { stateFile } = options;
  const stateKeyFile =
    options.stateKeyFile ?? (stateFile ? `${stateFile}.key` : undefined);
  const releaseStateLock = stateFile
    ? await acquireStateLock(stateFile)
    : async (): Promise<void> => undefined;
  let session: CliSession | undefined;

  try {
    const snapshot =
      stateFile && stateKeyFile
        ? await loadEncryptedState<CliSessionSnapshot>(stateFile, stateKeyFile)
        : undefined;

    if (
      snapshot &&
      options.privateKey &&
      snapshot.privateKey.toLowerCase() !== options.privateKey.toLowerCase()
    ) {
      throw new Error(
        "privateKey does not match the identity stored in the state file",
      );
    }

    const savedCoordinator = snapshot?.defaultCoordinator;
    const useSavedRelays =
      savedCoordinator &&
      (!options.serverPubkey ||
        options.serverPubkey.toLowerCase() ===
          savedCoordinator.serverPubkey.toLowerCase());
    const activeSession = new CliSession({
      privateKey: snapshot?.privateKey ?? options.privateKey,
      serverPubkey:
        options.serverPubkey ??
        savedCoordinator?.serverPubkey ??
        options.fallback?.serverPubkey ??
        DEFAULT_COORDINATOR_PUBKEY,
      relays:
        options.relays && options.relays.length > 0
          ? options.relays
          : ((useSavedRelays ? savedCoordinator?.relays : undefined) ??
            options.fallback?.relays ?? [...DEFAULT_RELAY_URLS]),
      mediaStore: options.mediaStore,
      transportEncryption: options.transportEncryption,
      onLocalStateAdvance: options.onLocalStateAdvance,
    });
    session = activeSession;
    if (snapshot) await activeSession.restoreSnapshot(snapshot);

    let durableQueue = Promise.resolve();
    let durabilityError: unknown;
    const persist = (beforeSave?: () => Promise<void>): Promise<void> => {
      const operation = durableQueue.then(async () => {
        if (durabilityError) throw durabilityError;
        try {
          await beforeSave?.();
          // ponytail: whole-snapshot rewrites stay simple; split history into
          // append-only storage only if real save latency becomes material.
          if (stateFile && stateKeyFile) {
            await saveEncryptedState(
              stateFile,
              stateKeyFile,
              await activeSession.exportSnapshotWhenIdle(),
            );
          }
        } catch (error) {
          durabilityError = error;
          throw error;
        }
      });
      // Keep the queue usable as a barrier without swallowing the caller's error.
      durableQueue = operation.catch(() => undefined);
      return operation;
    };

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        // Stop live ingestion before the final durability barrier; otherwise a
        // message can land after the last snapshot but before the lock is gone.
        await activeSession.disconnect();
        await durableQueue;
        if (!durabilityError) await persist();
      } finally {
        await releaseStateLock();
      }
    };

    return {
      session: activeSession,
      restored: snapshot !== undefined,
      persist,
      get durabilityError() {
        return durabilityError;
      },
      flush: () => durableQueue,
      close,
    };
  } catch (error) {
    await session?.disconnect();
    await releaseStateLock();
    throw error;
  }
}
