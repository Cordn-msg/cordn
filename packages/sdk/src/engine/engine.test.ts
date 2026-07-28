import { describe, expect, test } from "vitest";
import {
  clientStateEncoder,
  createApplicationMessage,
  createCommit,
  defaultProposalTypes,
  encode,
  mlsMessageEncoder,
  unsafeTestingAuthenticationService,
} from "ts-mls";

import {
  createActor,
  createMemberArtifacts,
  createThreeActorGroupScenario,
  getTestCiphersuite,
} from "@cordn/test-utils";

import { classifyProcessError } from "./classify.ts";
import { CordnGroupEngine } from "./engine.ts";
import type { InboundRecord, IngestResult, OutboundEffect } from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const enc = (s: string): Uint8Array => encoder.encode(s);
const dec = (b: Uint8Array): string => decoder.decode(b);

async function* from<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iter) {
    out.push(value);
  }
  return out;
}

async function ingest(
  engine: CordnGroupEngine,
  messages: readonly Uint8Array[],
): Promise<IngestResult[]> {
  const records: InboundRecord[] = messages.map((message) => ({ message }));
  return collect(engine.ingest(from(records)));
}

/** Ingest exactly one message and assert a single result. */
async function ingestOne(
  engine: CordnGroupEngine,
  message: Uint8Array,
): Promise<IngestResult> {
  const results = await ingest(engine, [message]);
  expect(results).toHaveLength(1);
  return results[0]!;
}

describe("classifyProcessError", () => {
  test("former-epoch strings", () => {
    expect(
      classifyProcessError(
        new Error("Cannot process commit or proposal from former epoch"),
      )?.cls,
    ).toBe("formerEpoch");
    expect(
      classifyProcessError(new Error("Cannot process message, epoch too old"))
        ?.cls,
    ).toBe("formerEpoch");
  });

  test("stale generation", () => {
    expect(
      classifyProcessError(new Error("Desired gen in the past"))?.cls,
    ).toBe("staleGeneration");
  });

  test("undecryptable", () => {
    expect(
      classifyProcessError(
        new Error("OperationError: The operation failed for some reason"),
      )?.cls,
    ).toBe("undecryptable");
  });

  test("removal commit", () => {
    expect(
      classifyProcessError(new Error("Could not find common ancestor"))?.cls,
    ).toBe("removalCommit");
  });

  test("ratchet tree invariant", () => {
    expect(
      classifyProcessError(
        new Error(
          "x non-blank intermediate node must list leaf node in its unmerged_leaves y",
        ),
      )?.cls,
    ).toBe("ratchetTreeInvariant");
  });

  test("unrecognized errors are undefined", () => {
    expect(classifyProcessError(new Error("totally unknown"))).toBeUndefined();
    expect(classifyProcessError("not even an error")).toBeUndefined();
  });
});

describe("CordnGroupEngine", () => {
  test("processes an inbound application message", async () => {
    const scenario = await createThreeActorGroupScenario();
    const ciphersuite = await getTestCiphersuite();
    const engine = new CordnGroupEngine(scenario.alice.state, {
      ciphersuite,
      localStablePubkey: scenario.alice.actor.stablePubkey,
    });

    const result = await ingestOne(engine, scenario.bobApplicationBytes);

    expect(result.disposition).toBe("processed");
    expect(dec(result.applicationMessage!)).toBe("hello from bob");
  });

  test("recognizes its own sent application message as self-echo", async () => {
    const scenario = await createThreeActorGroupScenario();
    const ciphersuite = await getTestCiphersuite();
    const engine = new CordnGroupEngine(scenario.alice.state, {
      ciphersuite,
      localStablePubkey: scenario.alice.actor.stablePubkey,
    });

    const sent = await engine.send({
      kind: "application",
      plaintext: enc("hi"),
    });
    const result = await ingestOne(engine, sent.ref);

    expect(result.disposition).toBe("selfEcho");
  });

  test("reports unreadable disposition for non-MLS bytes", async () => {
    const scenario = await createThreeActorGroupScenario();
    const ciphersuite = await getTestCiphersuite();
    const engine = new CordnGroupEngine(scenario.alice.state, { ciphersuite });

    const result = await ingestOne(engine, new Uint8Array([0, 1, 2, 3, 4]));

    expect(result.disposition).toBe("unreadable");
    expect(result.error?.code).toBe("INVALID_MLS_MESSAGE");
  });

  test("an add-commit self-echo emits storeWelcome and returns to stable", async () => {
    const scenario = await createThreeActorGroupScenario();
    const ciphersuite = await getTestCiphersuite();
    const engine = new CordnGroupEngine(scenario.alice.state, {
      ciphersuite,
      localStablePubkey: scenario.alice.actor.stablePubkey,
    });
    const dave = await createMemberArtifacts(createActor("dave"));

    const sent = await engine.send({
      kind: "commit",
      actions: [
        () => ({
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: dave.keyPackage },
        }),
      ],
    });
    expect(engine.lifecycle).toBe("pendingPublish");

    const result = await ingestOne(engine, sent.ref);

    expect(result.disposition).toBe("selfEcho");
    const welcomeEffect = result.effects?.find(
      (e): e is Extract<OutboundEffect, { kind: "storeWelcome" }> =>
        e.kind === "storeWelcome",
    );
    expect(welcomeEffect).toBeDefined();
    expect(welcomeEffect?.targetPubkey).toBe(dave.actor.stablePubkey);
    expect(engine.lifecycle).toBe("stable");
  });

  test("rollbackPending reverts a staged add-commit", async () => {
    const scenario = await createThreeActorGroupScenario();
    const ciphersuite = await getTestCiphersuite();
    const engine = new CordnGroupEngine(scenario.alice.state, {
      ciphersuite,
      localStablePubkey: scenario.alice.actor.stablePubkey,
    });
    const before = engine.state;
    const dave = await createMemberArtifacts(createActor("dave"));

    const sent = await engine.send({
      kind: "commit",
      actions: [
        () => ({
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: dave.keyPackage },
        }),
      ],
    });
    expect(engine.state).not.toBe(before);
    expect(engine.lifecycle).toBe("pendingPublish");

    engine.rollbackPending(sent.ref);

    expect(engine.state).toBe(before);
    expect(engine.lifecycle).toBe("stable");
  });

  test("self-echo prunes the sent ref (bounded set)", async () => {
    const scenario = await createThreeActorGroupScenario();
    const ciphersuite = await getTestCiphersuite();
    const engine = new CordnGroupEngine(scenario.alice.state, {
      ciphersuite,
      localStablePubkey: scenario.alice.actor.stablePubkey,
    });

    const sent = await engine.send({
      kind: "application",
      plaintext: enc("hi"),
    });
    expect(engine.serialize().sentRefs).toHaveLength(1);

    const result = await ingestOne(engine, sent.ref);
    expect(result.disposition).toBe("selfEcho");
    // Pruned on echo — the set only ever holds in-flight refs now.
    expect(engine.serialize().sentRefs).toEqual([]);
  });

  test("serialize/fromSerialized round-trips state, pending ops, and in-flight refs", async () => {
    const scenario = await createThreeActorGroupScenario();
    const ciphersuite = await getTestCiphersuite();
    const engine = new CordnGroupEngine(scenario.alice.state, {
      ciphersuite,
      localStablePubkey: scenario.alice.actor.stablePubkey,
    });
    const dave = await createMemberArtifacts(createActor("dave"));

    // A pending add-commit (publish-before-apply) + an in-flight app message.
    const commit = await engine.send({
      kind: "commit",
      actions: [
        () => ({
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: dave.keyPackage },
        }),
      ],
    });
    const appSent = await engine.send({
      kind: "application",
      plaintext: enc("in-flight"),
    });
    expect(engine.lifecycle).toBe("pendingPublish");

    const restored = CordnGroupEngine.fromSerialized(engine.serialize(), {
      ciphersuite,
      localStablePubkey: scenario.alice.actor.stablePubkey,
    });

    expect(encode(clientStateEncoder, restored.state)).toEqual(
      encode(clientStateEncoder, engine.state),
    );
    expect(restored.lifecycle).toBe("pendingPublish");
    expect(restored.serialize().sentRefs).toEqual(engine.serialize().sentRefs);

    // The pending add-commit survived: its self-echo finalizes + emits storeWelcome.
    const echo = await ingestOne(restored, commit.ref);
    expect(echo.disposition).toBe("selfEcho");
    expect(echo.effects?.some((e) => e.kind === "storeWelcome")).toBe(true);
    expect(restored.lifecycle).toBe("stable");

    // The in-flight app ref survived: self-echo reconciles without reprocessing.
    const appEcho = await ingestOne(restored, appSent.ref);
    expect(appEcho.disposition).toBe("selfEcho");
  });

  test("a future-epoch undecryptable message poisons the group (web rule)", async () => {
    const scenario = await createThreeActorGroupScenario();
    const ciphersuite = await getTestCiphersuite();
    const dave = await createMemberArtifacts(createActor("dave"));

    // alice advances an epoch (add dave), then sends an app message bob can't decrypt.
    const commitResult = await createCommit({
      context: {
        cipherSuite: ciphersuite,
        authService: unsafeTestingAuthenticationService,
      },
      state: scenario.alice.state,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: dave.keyPackage },
        },
      ],
    });
    const appResult = await createApplicationMessage({
      context: {
        cipherSuite: ciphersuite,
        authService: unsafeTestingAuthenticationService,
      },
      state: commitResult.newState,
      message: enc("future epoch"),
    });
    const futureMessage = encode(mlsMessageEncoder, appResult.message);

    // bob is still at the pre-dave epoch → undecryptable → poisoned.
    const bobEngine = new CordnGroupEngine(scenario.bob.state, {
      ciphersuite,
      localStablePubkey: scenario.bob.actor.stablePubkey,
    });
    const result = await ingestOne(bobEngine, futureMessage);

    expect(result.disposition).toBe("deferred");
    expect(bobEngine.status).toBe("poisoned");
  });

  test("a multi-add commit delivers a welcome to every added member", async () => {
    const scenario = await createThreeActorGroupScenario();
    const ciphersuite = await getTestCiphersuite();
    const engine = new CordnGroupEngine(scenario.alice.state, {
      ciphersuite,
      localStablePubkey: scenario.alice.actor.stablePubkey,
    });
    const dave = await createMemberArtifacts(createActor("dave"));
    const erin = await createMemberArtifacts(createActor("erin"));

    const sent = await engine.send({
      kind: "commit",
      actions: [
        () => ({
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: dave.keyPackage },
        }),
        () => ({
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: erin.keyPackage },
        }),
      ],
    });
    const result = await ingestOne(engine, sent.ref);

    expect(result.disposition).toBe("selfEcho");
    const welcomes =
      result.effects?.filter(
        (e): e is Extract<OutboundEffect, { kind: "storeWelcome" }> =>
          e.kind === "storeWelcome",
      ) ?? [];
    expect(welcomes).toHaveLength(2);
    expect(welcomes.map((w) => w.targetPubkey).sort()).toEqual(
      [dave.actor.stablePubkey, erin.actor.stablePubkey].sort(),
    );
  });

  test("concurrent sends are serialized: receiver accepts both in order (gotcha #5)", async () => {
    // Two application sends issued back-to-back before either resolves. Without
    // per-engine serialization both would derive from the same nonce generation
    // and the receiver would reject the second; with the queue they run one at a
    // time and both decrypt cleanly.
    const scenario = await createThreeActorGroupScenario();
    const ciphersuite = await getTestCiphersuite();
    const alice = new CordnGroupEngine(scenario.alice.state, {
      ciphersuite,
      localStablePubkey: scenario.alice.actor.stablePubkey,
    });
    const bob = new CordnGroupEngine(scenario.bob.state, {
      ciphersuite,
      localStablePubkey: scenario.bob.actor.stablePubkey,
    });

    const [r1, r2] = await Promise.all([
      alice.send({ kind: "application", plaintext: enc("m1") }),
      alice.send({ kind: "application", plaintext: enc("m2") }),
    ]);

    const [one, two] = await ingest(bob, [r1.ref, r2.ref]);
    expect(one!.disposition).toBe("processed");
    expect(dec(one!.applicationMessage!)).toBe("m1");
    expect(two!.disposition).toBe("processed");
    expect(dec(two!.applicationMessage!)).toBe("m2");
  });
});
