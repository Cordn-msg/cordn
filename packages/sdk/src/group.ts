import type { ProposalAction } from "./engine/types.ts";

import { encodeBase64 } from "@cordn/core";

import { CordnGroupEngine } from "./engine/engine.ts";
import type {
  GroupLifecycle,
  GroupStatus,
  InboundRecord,
  IngestResult,
  OutboundEffect,
} from "./engine/types.ts";
import type { SerializedGroupBlob } from "./storage.ts";
import type { CordnTransport } from "./transport.ts";

export interface CordnGroupOptions {
  /** Coordinator routing id (the delivery group identifier). */
  groupId: string;
  engine: CordnGroupEngine;
  transport: CordnTransport;
  /** Resume cursors (default 0). */
  fetchCursor?: number;
  lastCursor?: number;
}

export interface CordnGroupSendHandle {
  ref: Uint8Array;
}

async function* from<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

/**
 * A joined group session: a {@link CordnGroupEngine} bound to a coordinator
 * transport, with per-group cursor management.
 *
 * Encapsulates the cordn delivery methodology so app code never touches MLS
 * bytes or cursors directly: publish-before-apply (engine), per-group monotonic
 * cursors (gotcha #1), self-echo reconciliation (gotcha #2), and welcome
 * finalization with `joinAfterCursor` on a confirmed add-commit.
 *
 * See `design/cordn-sdk.md`.
 */
export class CordnGroup {
  readonly groupId: string;
  readonly engine: CordnGroupEngine;
  protected readonly transport: CordnTransport;
  private fetchCursorValue: number;
  private lastCursorValue: number;
  private readonly postedCursorByRef = new Map<string, number>();

  constructor(opts: CordnGroupOptions) {
    this.groupId = opts.groupId;
    this.engine = opts.engine;
    this.transport = opts.transport;
    this.fetchCursorValue = opts.fetchCursor ?? 0;
    this.lastCursorValue = opts.lastCursor ?? 0;
  }

  get fetchCursor(): number {
    return this.fetchCursorValue;
  }

  get lastCursor(): number {
    return this.lastCursorValue;
  }

  get status(): GroupStatus {
    return this.engine.status;
  }

  get lifecycle(): GroupLifecycle {
    return this.engine.lifecycle;
  }

  /** Cursor at which the group was poisoned (undefined unless `status === "poisoned"`). */
  get poisonedAtCursor(): number | undefined {
    return this.engine.poisonedAtCursor;
  }

  /** Snapshot this group's state for persistence. Restore via `CordnClient.groups.load`. */
  serialize(): SerializedGroupBlob {
    return {
      version: 1,
      groupId: this.groupId,
      engine: this.engine.serialize(),
      fetchCursor: this.fetchCursorValue,
      lastCursor: this.lastCursorValue,
    };
  }

  /** Send an application message; posts the MLS ciphertext to the coordinator. */
  async send(
    plaintext: Uint8Array,
    authenticatedData?: Uint8Array,
  ): Promise<CordnGroupSendHandle> {
    const result = await this.engine.send({
      kind: "application",
      plaintext,
      authenticatedData,
    });
    await this.publishEffects(result.effects);
    return { ref: result.ref };
  }

  /** Send a commit (batch add/remove/metadata proposal actions into one commit). */
  async commit(actions: ProposalAction[] = []): Promise<CordnGroupSendHandle> {
    const result = await this.engine.send({ kind: "commit", actions });
    await this.publishEffects(result.effects);
    return { ref: result.ref };
  }

  /**
   * Fetch backlog since the last cursor and ingest it. Advances the fetch cursor
   * and executes finalization effects (e.g. storeWelcome on a confirmed
   * add-commit self-echo). Returns one {@link IngestResult} per record.
   */
  async fetch(): Promise<IngestResult[]> {
    const messages = await this.transport.fetchGroupMessages({
      groupId: this.groupId,
      afterCursor: this.fetchCursorValue,
    });
    if (messages.length === 0) {
      return [];
    }

    const records: InboundRecord[] = messages.map((message) => ({
      message: message.opaqueMessage,
      cursor: message.cursor,
    }));
    const results: IngestResult[] = [];
    let index = 0;
    for await (const result of this.engine.ingest(from(records))) {
      this.advanceCursor(messages[index]!.cursor);
      index += 1;
      await this.applyEffects(result);
      results.push(result);
    }
    return results;
  }

  /**
   * Fetch-first-then-subscribe inbox runner (gotcha #1). Drains backlog, then
   * streams live messages through the same ingest path. Yields until the
   * optional abort signal fires.
   */
  async *runInbox(signal?: AbortSignal): AsyncGenerator<IngestResult> {
    while (true) {
      const batch = await this.fetch();
      if (batch.length === 0) {
        break;
      }
      for (const result of batch) {
        yield result;
      }
      if (signal?.aborted) {
        return;
      }
    }

    const stream = await this.transport.subscribeGroupMessages({
      groupId: this.groupId,
      afterCursor: this.fetchCursorValue,
    });
    try {
      for await (const record of stream.messages) {
        if (signal?.aborted) {
          return;
        }
        for await (const result of this.engine.ingest(
          from([{ message: record.opaqueMessage, cursor: record.cursor }]),
        )) {
          this.advanceCursor(record.cursor);
          await this.applyEffects(result);
          yield result;
        }
      }
    } finally {
      stream.unsubscribe();
    }
  }

  protected advanceCursor(cursor: number): void {
    this.fetchCursorValue = Math.max(this.fetchCursorValue, cursor);
    this.lastCursorValue = Math.max(this.lastCursorValue, cursor);
  }

  protected async publishEffects(effects: OutboundEffect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.kind !== "publish") {
        continue;
      }
      const posted = await this.transport.postGroupMessage({
        groupId: this.groupId,
        opaqueMessage: effect.message,
      });
      this.lastCursorValue = Math.max(this.lastCursorValue, posted.cursor);
      this.postedCursorByRef.set(encodeBase64(effect.ref), posted.cursor);
    }
  }

  /** Execute finalization effects from an ingest result (storeWelcome). */
  protected async applyEffects(result: IngestResult): Promise<void> {
    if (!result.effects) {
      return;
    }
    for (const effect of result.effects) {
      if (effect.kind !== "storeWelcome") {
        continue;
      }
      await this.transport.storeWelcome({
        targetStablePubkey: effect.targetPubkey,
        keyPackageReference: effect.keyPackageRef,
        welcome: effect.welcome,
        joinAfterCursor: this.postedCursorByRef.get(
          encodeBase64(result.message),
        ),
      });
    }
  }
}
