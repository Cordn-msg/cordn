import { describe, expect, test } from "vitest";
import { createGroup, unsafeTestingAuthenticationService } from "ts-mls";

import {
  createActor,
  createMemberArtifacts,
  createWelcomeForNewMember,
  getTestCiphersuite,
} from "@cordn/test-utils";

import { CordnGroupEngine } from "./engine/engine.ts";
import { createInProcessTransport } from "./testing/inProcessTransport.ts";
import { CordnGroup } from "./group.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("CordnGroup", () => {
  test("delivers an application message between two members via the coordinator", async () => {
    const cipherSuite = await getTestCiphersuite();
    const groupId = "group-alice-bob";
    const aliceArtifacts = await createMemberArtifacts(createActor("alice"));
    const bobArtifacts = await createMemberArtifacts(createActor("bob"));

    let aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: encoder.encode(groupId),
      keyPackage: aliceArtifacts.keyPackage,
      privateKeyPackage: aliceArtifacts.privateKeyPackage,
    });
    const bobJoin = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bobArtifacts,
    });
    aliceState = bobJoin.senderState;

    const { transport } = createInProcessTransport();
    const aliceGroup = new CordnGroup({
      groupId,
      engine: new CordnGroupEngine(aliceState, {
        ciphersuite: cipherSuite,
        localStablePubkey: aliceArtifacts.actor.stablePubkey,
      }),
      transport,
    });
    const bobGroup = new CordnGroup({
      groupId,
      engine: new CordnGroupEngine(bobJoin.receiverState, {
        ciphersuite: cipherSuite,
        localStablePubkey: bobArtifacts.actor.stablePubkey,
      }),
      transport,
    });

    await aliceGroup.send(encoder.encode("hi bob"));

    const results = await bobGroup.fetch();
    const processed = results.find((r) => r.disposition === "processed");
    expect(processed).toBeDefined();
    expect(decoder.decode(processed!.applicationMessage!)).toBe("hi bob");
    expect(bobGroup.fetchCursor).toBe(1);
    expect(bobGroup.lastCursor).toBe(1);
  });

  test("a sender's own message is reconciled as self-echo on fetch", async () => {
    const cipherSuite = await getTestCiphersuite();
    const groupId = "group-self-echo";
    const aliceArtifacts = await createMemberArtifacts(createActor("alice"));
    const bobArtifacts = await createMemberArtifacts(createActor("bob"));
    let aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: encoder.encode(groupId),
      keyPackage: aliceArtifacts.keyPackage,
      privateKeyPackage: aliceArtifacts.privateKeyPackage,
    });
    const bobJoin = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bobArtifacts,
    });
    aliceState = bobJoin.senderState;

    const { transport } = createInProcessTransport();
    const aliceGroup = new CordnGroup({
      groupId,
      engine: new CordnGroupEngine(aliceState, {
        ciphersuite: cipherSuite,
        localStablePubkey: aliceArtifacts.actor.stablePubkey,
      }),
      transport,
    });

    await aliceGroup.send(encoder.encode("echo me"));
    const results = await aliceGroup.fetch();
    expect(results.find((r) => r.disposition === "selfEcho")).toBeDefined();
    expect(aliceGroup.fetchCursor).toBe(1);
  });

  test("a second fetch after catch-up returns nothing", async () => {
    const cipherSuite = await getTestCiphersuite();
    const groupId = "group-catchup";
    const aliceArtifacts = await createMemberArtifacts(createActor("alice"));
    const bobArtifacts = await createMemberArtifacts(createActor("bob"));
    let aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: encoder.encode(groupId),
      keyPackage: aliceArtifacts.keyPackage,
      privateKeyPackage: aliceArtifacts.privateKeyPackage,
    });
    const bobJoin = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bobArtifacts,
    });
    aliceState = bobJoin.senderState;

    const { transport } = createInProcessTransport();
    const bobGroup = new CordnGroup({
      groupId,
      engine: new CordnGroupEngine(bobJoin.receiverState, {
        ciphersuite: cipherSuite,
        localStablePubkey: bobArtifacts.actor.stablePubkey,
      }),
      transport,
    });
    const aliceGroup = new CordnGroup({
      groupId,
      engine: new CordnGroupEngine(aliceState, {
        ciphersuite: cipherSuite,
        localStablePubkey: aliceArtifacts.actor.stablePubkey,
      }),
      transport,
    });

    await aliceGroup.send(encoder.encode("one"));
    expect((await bobGroup.fetch()).length).toBe(1);
    expect(await bobGroup.fetch()).toEqual([]);
  });

  test("serialize → load round-trips a live group and resumes from the cursor", async () => {
    const cipherSuite = await getTestCiphersuite();
    const groupId = "group-recovery";
    const aliceArtifacts = await createMemberArtifacts(createActor("alice"));
    const bobArtifacts = await createMemberArtifacts(createActor("bob"));
    let aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: encoder.encode(groupId),
      keyPackage: aliceArtifacts.keyPackage,
      privateKeyPackage: aliceArtifacts.privateKeyPackage,
    });
    const bobJoin = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bobArtifacts,
    });
    aliceState = bobJoin.senderState;

    const { transport } = createInProcessTransport();
    const aliceGroup = new CordnGroup({
      groupId,
      engine: new CordnGroupEngine(aliceState, {
        ciphersuite: cipherSuite,
        localStablePubkey: aliceArtifacts.actor.stablePubkey,
      }),
      transport,
    });
    const bobGroup = new CordnGroup({
      groupId,
      engine: new CordnGroupEngine(bobJoin.receiverState, {
        ciphersuite: cipherSuite,
        localStablePubkey: bobArtifacts.actor.stablePubkey,
      }),
      transport,
    });

    await aliceGroup.send(encoder.encode("before snapshot"));
    await bobGroup.fetch(); // bob consumes → fetchCursor advances

    // Snapshot bob, "restart", rebuild from the blob, continue delivery.
    const blob = bobGroup.serialize();
    const restoredBob = new CordnGroup({
      groupId: blob.groupId,
      engine: CordnGroupEngine.fromSerialized(blob.engine, {
        ciphersuite: cipherSuite,
        localStablePubkey: bobArtifacts.actor.stablePubkey,
      }),
      transport,
      fetchCursor: blob.fetchCursor,
      lastCursor: blob.lastCursor,
    });

    await aliceGroup.send(encoder.encode("after snapshot"));
    const results = await restoredBob.fetch();
    // Resumed from the persisted cursor: only the post-snapshot message arrives.
    const processed = results.find((r) => r.disposition === "processed");
    expect(processed).toBeDefined();
    expect(decoder.decode(processed!.applicationMessage!)).toBe(
      "after snapshot",
    );
  });

  test("runInbox drains backlog then delivers live messages through one path", async () => {
    const cipherSuite = await getTestCiphersuite();
    const groupId = "group-inbox";
    const aliceArtifacts = await createMemberArtifacts(createActor("alice"));
    const bobArtifacts = await createMemberArtifacts(createActor("bob"));
    let aliceState = await createGroup({
      context: { cipherSuite, authService: unsafeTestingAuthenticationService },
      groupId: encoder.encode(groupId),
      keyPackage: aliceArtifacts.keyPackage,
      privateKeyPackage: aliceArtifacts.privateKeyPackage,
    });
    const bobJoin = await createWelcomeForNewMember({
      senderState: aliceState,
      member: bobArtifacts,
    });
    aliceState = bobJoin.senderState;

    const { transport } = createInProcessTransport();
    const aliceGroup = new CordnGroup({
      groupId,
      engine: new CordnGroupEngine(aliceState, {
        ciphersuite: cipherSuite,
        localStablePubkey: aliceArtifacts.actor.stablePubkey,
      }),
      transport,
    });
    const bobGroup = new CordnGroup({
      groupId,
      engine: new CordnGroupEngine(bobJoin.receiverState, {
        ciphersuite: cipherSuite,
        localStablePubkey: bobArtifacts.actor.stablePubkey,
      }),
      transport,
    });

    // Backlog exists before Bob listens.
    await aliceGroup.send(encoder.encode("backlog"));
    expect(bobGroup.fetchCursor).toBe(0);

    const inbox = bobGroup.runInbox();

    // 1) Backlog is drained first via fetch.
    const first = await inbox.next();
    expect(first.done).toBe(false);
    expect(first.value!.disposition).toBe("processed");
    expect(decoder.decode(first.value!.applicationMessage!)).toBe("backlog");
    expect(bobGroup.fetchCursor).toBe(1);

    // 2) Resume into subscribe; let pending microtasks drain so the subscriber
    //    registers before we post the live message.
    const livePromise = inbox.next();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 3) A message posted after subscription arrives live (no re-delivery of backlog).
    await aliceGroup.send(encoder.encode("live"));
    const second = await livePromise;
    expect(second.done).toBe(false);
    expect(second.value!.disposition).toBe("processed");
    expect(decoder.decode(second.value!.applicationMessage!)).toBe("live");

    await inbox.return(undefined); // close generator → unsubscribe (finally)
  });
});
