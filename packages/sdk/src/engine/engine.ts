import {
  clientStateDecoder,
  clientStateEncoder,
  createApplicationMessage,
  createCommit,
  createProposal,
  defaultProposalTypes,
  encode,
  makeKeyPackageRef,
  mlsMessageDecoder,
  mlsMessageEncoder,
  processMessage,
  unsafeTestingAuthenticationService,
  wireformats,
  type ClientState,
  type Hash,
  type IncomingMessageCallback,
  type KeyPackage,
  type MlsFramedMessage,
  type Proposal,
  type Welcome,
} from "ts-mls";

import { decodeWelcome, encodeBase64, encodeWelcome } from "@cordn/core";

import {
  FormerEpochError,
  InvalidMlsMessageError,
  MemberRemovalCommitError,
  NotImplementedError,
  RatchetTreeInvariantError,
  StaleGenerationError,
  UndecryptableMessageError,
} from "./errors.ts";
import { classifyProcessError } from "./classify.ts";
import { findMemberLeafIndexByStablePubkey } from "./members.ts";
import type {
  CordnGroupEngineOptions,
  GroupLifecycle,
  GroupStatus,
  InboundRecord,
  IngestDisposition,
  IngestResult,
  MessageRef,
  OutboundEffect,
  ProposalContext,
  SendIntent,
  SendResult,
  SerializedAddTarget,
  SerializedEngineState,
  SerializedPendingOp,
} from "./types.ts";

const textDecoder = new TextDecoder();

type PendingOp =
  | {
      kind: "add";
      prevState: ClientState;
      welcome: Welcome;
      /** One per added member — a single Welcome covers them all (gotcha fix). */
      targets: Array<{ targetPubkey: string; keyPackageRef: string }>;
    }
  | { kind: "other"; prevState: ClientState };

type Release = () => void;

function refKey(message: Uint8Array): string {
  return encodeBase64(message);
}

function decodeFramed(bytes: Uint8Array): MlsFramedMessage {
  const decoded = mlsMessageDecoder(bytes, 0);
  if (!decoded) {
    throw new InvalidMlsMessageError();
  }
  if (
    decoded[0].wireformat !== wireformats.mls_private_message &&
    decoded[0].wireformat !== wireformats.mls_public_message
  ) {
    throw new InvalidMlsMessageError("Expected framed MLS message");
  }
  return decoded[0];
}

function isRemovedFromGroup(state: ClientState): boolean {
  return (
    (state as unknown as { groupActiveState?: { kind?: string } })
      .groupActiveState?.kind === "removedFromGroup"
  );
}

export function keyPackageStablePubkey(keyPackage: KeyPackage): string {
  const credential = keyPackage.leafNode.credential as
    | { identity?: Uint8Array }
    | undefined;
  if (!credential?.identity) {
    throw new InvalidMlsMessageError(
      "Key package lacks a BasicCredential identity",
    );
  }
  return textDecoder.decode(credential.identity);
}

interface AddTarget {
  keyPackage: KeyPackage;
  targetPubkey: string;
  keyPackageRef: string;
}

async function findAddTargets(
  extraProposals: readonly Proposal[] | undefined,
  hash: Hash,
): Promise<AddTarget[]> {
  if (!extraProposals) {
    return [];
  }
  const targets: AddTarget[] = [];
  for (const raw of extraProposals) {
    const proposal = raw as {
      proposalType?: number;
      add?: { keyPackage?: KeyPackage };
    };
    if (
      proposal.proposalType === defaultProposalTypes.add &&
      proposal.add?.keyPackage
    ) {
      const keyPackage = proposal.add.keyPackage;
      targets.push({
        keyPackage,
        targetPubkey: keyPackageStablePubkey(keyPackage),
        keyPackageRef: Buffer.from(
          await makeKeyPackageRef(keyPackage, hash),
        ).toString("hex"),
      });
    }
  }
  return targets;
}

/** Minimal per-engine promise chain: one in-flight operation at a time. */
function serialize(): { acquire: () => Promise<Release> } {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    acquire: () => {
      let release!: Release;
      const gate = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const turn = tail.then(() => undefined);
      tail = turn.then(() => gate);
      return turn.then(() => release);
    },
  };
}

/**
 * Transport-agnostic cordn group state machine.
 *
 * Owns a ts-mls `ClientState` and encapsulates the cordn MLS gotchas:
 * publish-before-apply lifecycle, structured ingest dispositions (replacing
 * ts-mls error string-matching), per-group operation serialization (gotcha #5),
 * and self-echo reconciliation (gotcha #2). Never touches a transport — it emits
 * `OutboundEffect`s for the client layer to publish.
 *
 * See `design/cordn-sdk.md`.
 */
export class CordnGroupEngine {
  private stateValue: ClientState;
  private statusValue: GroupStatus = "active";
  private poisonedAtCursorValue?: number;
  private lifecycleValue: GroupLifecycle;
  private readonly sentRefs = new Set<string>();
  private readonly pending = new Map<string, PendingOp>();
  private readonly queue = serialize();
  private readonly opts: CordnGroupEngineOptions;

  constructor(initialState: ClientState, opts: CordnGroupEngineOptions) {
    this.stateValue = initialState;
    this.opts = opts;
    this.lifecycleValue = opts.lifecycle ?? "stable";
  }

  get state(): ClientState {
    return this.stateValue;
  }

  get status(): GroupStatus {
    return this.statusValue;
  }

  /** Cursor at which the group was poisoned (undefined unless `status === "poisoned"`). */
  get poisonedAtCursor(): number | undefined {
    return this.poisonedAtCursorValue;
  }

  get lifecycle(): GroupLifecycle {
    return this.lifecycleValue;
  }

  private context() {
    return {
      cipherSuite: this.opts.ciphersuite,
      authService: this.opts.authService ?? unsafeTestingAuthenticationService,
    };
  }

  /**
   * Send an intent. Serialized: one in-flight operation at a time (gotcha #5).
   * Advances state optimistically (publish-before-apply) and returns the bytes
   * to publish plus any immediate effects.
   */
  async send(intent: SendIntent): Promise<SendResult> {
    const release = await this.queue.acquire();
    try {
      switch (intent.kind) {
        case "application":
          return await this.sendApplication(intent);
        case "proposal":
          return await this.sendProposal(intent);
        case "commit":
          return await this.sendCommit(intent);
        case "selfUpdate":
          throw new NotImplementedError("selfUpdate is not implemented yet");
      }
    } finally {
      release();
    }
  }

  private async sendApplication(
    intent: Extract<SendIntent, { kind: "application" }>,
  ): Promise<SendResult> {
    const result = await createApplicationMessage({
      context: this.context(),
      state: this.stateValue,
      message: intent.plaintext,
      authenticatedData: intent.authenticatedData,
    });
    this.stateValue = result.newState;
    const message = encode(mlsMessageEncoder, result.message);
    this.sentRefs.add(refKey(message));
    return {
      ref: message,
      effects: [{ kind: "publish", message, ref: message }],
    };
  }

  private async sendProposal(
    intent: Extract<SendIntent, { kind: "proposal" }>,
  ): Promise<SendResult> {
    const result = await createProposal({
      context: this.context(),
      state: this.stateValue,
      proposal: intent.proposal,
    });
    this.stateValue = result.newState;
    const message = encode(mlsMessageEncoder, result.message);
    this.sentRefs.add(refKey(message));
    return {
      ref: message,
      effects: [{ kind: "publish", message, ref: message }],
    };
  }

  private async sendCommit(
    intent: Extract<SendIntent, { kind: "commit" }>,
  ): Promise<SendResult> {
    // Resolve proposal actions against the current state, inside the serialized
    // turn — actions may depend on live state (e.g. remove-by-leaf-index).
    const ctx: ProposalContext = {
      ciphersuite: this.opts.ciphersuite,
      state: this.stateValue,
      localStablePubkey: this.opts.localStablePubkey,
    };
    const extraProposals: Proposal[] = [];
    for (const action of intent.actions ?? []) {
      extraProposals.push(await action(ctx));
    }

    const result = await createCommit({
      context: this.context(),
      state: this.stateValue,
      ratchetTreeExtension: true,
      extraProposals,
    });
    const prevState = this.stateValue;
    this.stateValue = result.newState;
    const message = encode(mlsMessageEncoder, result.commit);
    this.sentRefs.add(refKey(message));
    this.lifecycleValue = "pendingPublish";

    if (result.welcome) {
      const targets = await findAddTargets(
        extraProposals,
        this.opts.ciphersuite.hash,
      );
      if (targets.length > 0) {
        this.pending.set(refKey(message), {
          kind: "add",
          prevState,
          welcome: result.welcome.welcome,
          targets: targets.map(({ targetPubkey, keyPackageRef }) => ({
            targetPubkey,
            keyPackageRef,
          })),
        });
      } else {
        this.pending.set(refKey(message), { kind: "other", prevState });
      }
    } else if (extraProposals.length > 0) {
      this.pending.set(refKey(message), { kind: "other", prevState });
    }

    return {
      ref: message,
      effects: [{ kind: "publish", message, ref: message }],
    };
  }

  /**
   * Explicitly confirm a published commit (advance lifecycle to stable, emit
   * finalization effects like `storeWelcome`). Normally invoked automatically
   * by `ingest` on self-echo; exposed for out-of-band confirmation.
   */
  confirmPublished(ref: MessageRef): OutboundEffect[] {
    return this.confirmPending(refKey(ref));
  }

  /**
   * Roll back a staged commit whose publish failed. Reverts the optimistic
   * state advance and drops the pending op. Application-message sends are not
   * reverted (the ratchet already advanced; resend produces a new message).
   */
  rollbackPending(ref: MessageRef): void {
    const key = refKey(ref);
    const op = this.pending.get(key);
    if (op) {
      this.stateValue = op.prevState;
      this.pending.delete(key);
    }
    this.sentRefs.delete(key);
    if (this.pending.size === 0) {
      this.lifecycleValue = "stable";
    }
  }

  /**
   * Ingest inbound records. Single ingestion path for fetch backlog and live
   * stream (gotcha #1). Yields one structured `IngestResult` per record.
   */
  async *ingest(
    records: AsyncIterable<InboundRecord>,
  ): AsyncGenerator<IngestResult> {
    for await (const record of records) {
      yield* this.ingestOne(record);
    }
  }

  private async *ingestOne(
    record: InboundRecord,
  ): AsyncGenerator<IngestResult> {
    const key = refKey(record.message);

    // Self-echo reconciliation (gotcha #2): match our own published bytes and
    // skip MLS reprocessing. Confirms any pending commit (emitting storeWelcome).
    if (this.sentRefs.has(key)) {
      // Prune: the coordinator cursor is now past this message, so it cannot be
      // re-delivered. Keeps `sentRefs` bounded to in-flight refs (and makes the
      // serialized snapshot small). Safe because cursors forbid re-delivery.
      this.sentRefs.delete(key);
      yield {
        message: record.message,
        disposition: "selfEcho",
        effects: this.confirmPending(key),
      };
      return;
    }

    let framed: MlsFramedMessage;
    try {
      framed = decodeFramed(record.message);
    } catch (error) {
      yield {
        message: record.message,
        disposition: "unreadable",
        error:
          error instanceof InvalidMlsMessageError
            ? error
            : new InvalidMlsMessageError(),
      };
      return;
    }

    let processed: Awaited<ReturnType<typeof processMessage>>;
    try {
      processed = await processMessage({
        context: this.context(),
        state: this.stateValue,
        message: framed,
        callback: this.opts.adminPolicy as IncomingMessageCallback | undefined,
      });
    } catch (error) {
      const classified = classifyProcessError(error);
      if (!classified) {
        throw error;
      }
      if (classified.cls === "removalCommit") {
        this.statusValue = "removed";
        yield {
          message: record.message,
          disposition: "removed",
          error: new MemberRemovalCommitError(classified.message),
        };
        return;
      }
      const error_:
        | FormerEpochError
        | StaleGenerationError
        | RatchetTreeInvariantError
        | UndecryptableMessageError = (() => {
        switch (classified.cls) {
          case "formerEpoch":
            return new FormerEpochError(classified.message);
          case "staleGeneration":
            return new StaleGenerationError(classified.message);
          case "ratchetTreeInvariant":
            return new RatchetTreeInvariantError(classified.message);
          default: {
            // Poisoning rule (web chatGroupMessages.ts): undecryptable ∧ not
            // former-epoch ∧ status !== removed → poisoned. The other classes are
            // mutually exclusive with `undecryptable`, so `cls` alone is the gate.
            if (this.statusValue !== "removed") {
              this.statusValue = "poisoned";
              this.poisonedAtCursorValue = record.cursor;
            }
            return new UndecryptableMessageError(classified.message);
          }
        }
      })();
      yield {
        message: record.message,
        disposition: "deferred" satisfies IngestDisposition,
        error: error_,
      };
      return;
    }

    // Admin-policy rejection surfaced as a structured callback result.
    if (processed.kind === "newState" && processed.actionTaken === "reject") {
      yield { message: record.message, disposition: "rejectedByPolicy" };
      return;
    }

    if (processed.kind === "applicationMessage") {
      this.stateValue = processed.newState;
      if (isRemovedFromGroup(processed.newState)) {
        this.statusValue = "removed";
        yield { message: record.message, disposition: "removed" };
        return;
      }
      yield {
        message: record.message,
        disposition: "processed",
        applicationMessage: processed.message,
        authenticatedData: processed.aad,
      };
      return;
    }

    // newState: a commit or proposal advanced the group state.
    this.stateValue = processed.newState;
    const removed =
      isRemovedFromGroup(processed.newState) ||
      (this.opts.localStablePubkey !== undefined &&
        findMemberLeafIndexByStablePubkey(
          processed.newState,
          this.opts.localStablePubkey,
        ) < 0);
    if (removed) {
      this.statusValue = "removed";
      yield { message: record.message, disposition: "removed" };
      return;
    }
    yield { message: record.message, disposition: "processed" };
  }

  private confirmPending(key: string): OutboundEffect[] {
    const op = this.pending.get(key);
    if (!op) {
      return [];
    }
    this.pending.delete(key);
    if (this.pending.size === 0) {
      this.lifecycleValue = "stable";
    }
    if (op.kind === "add") {
      // One Welcome covers all added members; deliver it to each target.
      return op.targets.map((target) => ({
        kind: "storeWelcome" as const,
        targetPubkey: target.targetPubkey,
        welcome: op.welcome,
        keyPackageRef: target.keyPackageRef,
      }));
    }
    return [];
  }

  /** Reset a poisoned group to `active`. Full recovery (re-fetch / rejoin) is
   *  app-driven — the SDK exposes the status + cursor, not the policy. */
  clearPoisoned(): void {
    if (this.statusValue === "poisoned") {
      this.statusValue = "active";
      this.poisonedAtCursorValue = undefined;
    }
  }

  /** Snapshot engine state for persistence. Captures everything that affects
   *  future ingest: state, pending epoch ops, in-flight sent refs, lifecycle,
   *  status, poisonedAtCursor. Round-trips via `CordnGroupEngine.fromSerialized`. */
  serialize(): SerializedEngineState {
    return {
      state: encode(clientStateEncoder, this.stateValue),
      lifecycle: this.lifecycleValue,
      status: this.statusValue,
      poisonedAtCursor: this.poisonedAtCursorValue,
      pending: [...this.pending.entries()].map(
        ([refKey, op]): SerializedPendingOp =>
          op.kind === "add"
            ? {
                refKey,
                kind: "add",
                prevState: encode(clientStateEncoder, op.prevState),
                welcome: encodeWelcome(op.welcome),
                targets: op.targets.map(
                  (t): SerializedAddTarget => ({
                    targetPubkey: t.targetPubkey,
                    keyPackageRef: t.keyPackageRef,
                  }),
                ),
              }
            : {
                refKey,
                kind: "other",
                prevState: encode(clientStateEncoder, op.prevState),
              },
      ),
      sentRefs: [...this.sentRefs],
    };
  }

  /** Rebuild an engine from a prior `serialize()` snapshot. */
  static fromSerialized(
    serialized: SerializedEngineState,
    opts: CordnGroupEngineOptions,
  ): CordnGroupEngine {
    const engine = new CordnGroupEngine(
      decodeClientState(serialized.state),
      opts,
    );
    engine.lifecycleValue = serialized.lifecycle;
    engine.statusValue = serialized.status;
    engine.poisonedAtCursorValue = serialized.poisonedAtCursor;
    engine.sentRefs.clear();
    for (const ref of serialized.sentRefs) {
      engine.sentRefs.add(ref);
    }
    for (const op of serialized.pending) {
      const prevState = decodeClientState(op.prevState);
      if (op.kind === "add") {
        engine.pending.set(op.refKey, {
          kind: "add",
          prevState,
          welcome: decodeWelcome(op.welcome!),
          targets: op.targets ?? [],
        });
      } else {
        engine.pending.set(op.refKey, { kind: "other", prevState });
      }
    }
    return engine;
  }
}

function decodeClientState(bytes: Uint8Array): ClientState {
  const decoded = clientStateDecoder(bytes, 0);
  if (!decoded) {
    throw new InvalidMlsMessageError("Invalid serialized ClientState");
  }
  return decoded[0];
}
