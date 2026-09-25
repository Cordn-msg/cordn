import { afterEach, describe, expect, test } from "vitest";

import { CliSession } from "./session.ts";
import { cordnClient } from "./coordinatorClient.ts";
import type { CoordinatorTarget } from "./coordinatorRegistry.ts";
import {
  causalPrevTags,
  createUnsignedCordnMessageEvent,
} from "./messageEnvelope.ts";
import {
  createApplicationMessageBase64,
  encodeAuthenticatedSender,
  encryptGroupPayload,
} from "./utils/mlsMessages.ts";
import { updateGroupMetadataExtension } from "./utils/mlsGroupLifecycle.ts";
import type { CordnCoordinatorRouting } from "./coordinatorRouting.ts";
import { decodeBase64 } from "./utils/mlsBase.ts";
import { createPrivateKeyHex } from "./utils/mlsIdentity.ts";
import { connectServer } from "@cordn/server";
import { MockRelayHub } from "@cordn/test-utils";
import { PrivateKeySigner } from "@contextvm/sdk";

/** Coordinator handoff end-to-end (spec/applications/coordinator-handoff.md):
 * three real coordinators, real MLS groups, planned handoffs, the counted-history
 * gate, late writes to a closing stream, author rescue by re-linking, and
 * §6.2 re-sends healing gaps. */

interface Harness {
  relayHub: MockRelayHub;
  server1Pubkey: string;
  server2Pubkey: string;
  server3Pubkey: string;
  stopServer1: () => Promise<void>;
  makeSession: () => {
    session: CliSession;
    target1: CoordinatorTarget;
    target2: CoordinatorTarget;
    target3: CoordinatorTarget;
  };
  close: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const relayHub = new MockRelayHub();
  const signer1 = new PrivateKeySigner();
  const signer2 = new PrivateKeySigner();
  const signer3 = new PrivateKeySigner();
  const server1Pubkey = await signer1.getPublicKey();
  const server2Pubkey = await signer2.getPublicKey();
  const server3Pubkey = await signer3.getPublicKey();
  const servers = await Promise.all([
    connectServer({
      signer: signer1,
      relayHandler: relayHub.createRelayHandler(),
    }),
    connectServer({
      signer: signer2,
      relayHandler: relayHub.createRelayHandler(),
    }),
    connectServer({
      signer: signer3,
      relayHandler: relayHub.createRelayHandler(),
    }),
  ]);
  const sessions: CliSession[] = [];
  const clients: cordnClient[] = [];
  const deadServers = new Set<number>();
  // Death simulation: a stopped coordinator's transport refuses publishes
  // (connection refused), instead of hanging requests forever.
  const guard = (
    server: number,
    target: CoordinatorTarget,
  ): CoordinatorTarget => {
    const handler = target.relayHandler;
    if (!handler) return target;
    const publish = handler.publish.bind(handler);
    handler.publish = (event) =>
      deadServers.has(server)
        ? Promise.reject(new Error(`coordinator ${server} is unreachable`))
        : publish(event);
    return target;
  };

  return {
    relayHub,
    server1Pubkey,
    server2Pubkey,
    server3Pubkey,
    makeSession() {
      const target1: CoordinatorTarget = guard(1, {
        serverPubkey: server1Pubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const target2: CoordinatorTarget = guard(2, {
        serverPubkey: server2Pubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const target3: CoordinatorTarget = guard(3, {
        serverPubkey: server3Pubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const session = new CliSession({
        defaultCoordinator: target1,
        coordinators: { [server2Pubkey]: target2, [server3Pubkey]: target3 },
      });
      sessions.push(session);
      return { session, target1, target2, target3 };
    },
    stopServer1: async () => {
      deadServers.add(1);
      await servers[0]!.transport.close();
    },
    close: async () => {
      await Promise.allSettled(sessions.map((session) => session.disconnect()));
      await Promise.allSettled(clients.map((client) => client.disconnect()));
      await Promise.allSettled(
        servers.map((server) => server.transport.close()),
      );
    },
  };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A member's device that is behind the cut posts to the closing coordinator
 *  after the routing commit — the §13 "late write" case. The record is held
 *  locally as an outbound message, exactly as a stale device would hold it. */
async function postStaleOutbound(params: {
  session: CliSession;
  relayHub: MockRelayHub;
  serverPubkey: string;
  content: string;
}): Promise<{ id: string; cursor: number }> {
  const group = params.session.getGroup("demo");
  const outbound = await createApplicationMessageBase64({
    state: group.state,
    event: createUnsignedCordnMessageEvent({
      pubkey: params.session.stablePubkey,
      content: params.content,
      tags: causalPrevTags(group.messages),
    }),
    authenticatedData: encodeAuthenticatedSender(params.session.stablePubkey),
  });
  group.state = outbound.newState;
  const msg_64 = (
    await encryptGroupPayload({
      state: group.state,
      serializedMlsMessage: decodeBase64(outbound.opaqueMessageBase64),
    })
  ).encryptedBase64;

  const client = new cordnClient({
    serverPubkey: params.serverPubkey,
    relayHandler: params.relayHub.createRelayHandler(),
    privateKey: createPrivateKeyHex(),
  });
  try {
    const posted = await client.PostGroupMessage({
      msg_64,
      gid: params.session.deriveGroupId(group.state),
    });
    group.messages.push({
      cursor: posted.cursor,
      createdAt: outbound.event.created_at,
      direction: "outbound",
      sender: params.session.stablePubkey,
      id: outbound.event.id,
      kind: outbound.event.kind,
      tags: outbound.event.tags,
      content: outbound.event.content,
    });
    group.lastCursor = Math.max(group.lastCursor, posted.cursor);
    return { id: outbound.event.id, cursor: posted.cursor };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

/** A stale device's blind failover commit — the §10 "commits created without
 *  ingesting each other" fork: built from the member's current state and
 *  posted raw to a fallback, exactly as postStaleOutbound posts late writes. */
async function postStaleRoutingCommit(params: {
  session: CliSession;
  relayHub: MockRelayHub;
  serverPubkey: string;
  routing: CordnCoordinatorRouting;
}): Promise<{ cursor: number }> {
  const group = params.session.getGroup("demo");
  const prepared = await updateGroupMetadataExtension({
    state: group.state,
    metadata: { ...group.metadata!, coordinatorRouting: params.routing },
  });
  const msg_64 = (
    await encryptGroupPayload({
      state: group.state,
      serializedMlsMessage: decodeBase64(prepared.commitMessageBase64),
    })
  ).encryptedBase64;
  const client = new cordnClient({
    serverPubkey: params.serverPubkey,
    relayHandler: params.relayHub.createRelayHandler(),
    privateKey: createPrivateKeyHex(),
  });
  try {
    const posted = await client.PostGroupMessage({
      msg_64,
      gid: params.session.deriveGroupId(group.state),
    });
    return { cursor: posted.cursor };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

async function bootstrapGroup(
  alice: CliSession,
  bob: CliSession,
  harness: Harness,
): Promise<{ id: string; cursor: number }> {
  const locator = (pubkey: string) => ({
    pubkey: pubkey.toLowerCase(),
    relayUrls: [],
  });
  await alice.generateKeyPackage("alice-main");
  await bob.generateKeyPackage("bob-main");
  await alice.createGroup("demo", {
    keyPackageAlias: "alice-main",
    metadata: {
      name: "demo",
      // The roster rides the metadata document: declared at birth here,
      // editable any time like the rest of the document (§4.4/§4.5).
      coordinatorRouting: {
        active: locator(harness.server1Pubkey),
        fallbacks: [
          locator(harness.server2Pubkey),
          locator(harness.server3Pubkey),
        ],
        boundaryTips: [],
      },
    },
  });
  const invitation = await alice.addMember("demo", bob.stablePubkey);
  await alice.syncGroup("demo");
  await bob.fetchWelcomes();
  await bob.acceptWelcome(invitation.keyPackageReference, "demo");
  const one = await alice.sendMessage("demo", "one");
  await bob.syncGroup("demo");
  return one;
}

describe("coordinator handoff (session)", () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    await Promise.allSettled(harnesses.splice(0).map((h) => h.close()));
  });

  test("planned handoff: the cut carries the tips, adoption switches both sides, and counted history survives the switch — including a return trip", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice, target2 } = harness.makeSession();
    const { session: bob, target1: bobTarget1 } = harness.makeSession();

    const one = await bootstrapGroup(alice, bob, harness);

    const { cursor: cutCursor } = await alice.switchCoordinator(
      "demo",
      target2,
    );
    expect(cutCursor).toBeGreaterThan(0);

    // The routing state records the handoff and the cut tips (§4.4, §9).
    const routing = alice.getGroup("demo").metadata?.coordinatorRouting;
    expect(routing?.active.pubkey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );
    // The cut carries exactly the committer's confirmed tips (§7.1).
    expect(routing?.boundaryTips).toEqual([one.id]);
    expect(routing?.fallbacks.map((f) => f.pubkey.toLowerCase())).toContain(
      harness.server1Pubkey.toLowerCase(),
    );

    // The author's switch is immediate (§9 step 6): rebound, fresh fetch
    // progression on the new coordinator's line.
    expect(alice.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );
    expect(alice.getGroup("demo").fetchCursor).toBe(0);

    // Bob adopts by processing the routing commit from the closing stream.
    await bob.syncGroup("demo");
    expect(bob.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );
    expect(bob.getGroup("demo").fetchCursor).toBe(0);
    expect(
      bob.getGroup("demo").metadata?.coordinatorRouting?.boundaryTips,
    ).toEqual([one.id]);

    // Chat continues on the new coordinator (fresh line, first cursor).
    const two = await alice.sendMessage("demo", "two");
    expect(two.cursor).toBe(1);
    // Links reach across the seam: the new record's tip is the old one (§6).
    expect(two.tags.some((t) => t[0] === "prev" && t[1] === one.id)).toBe(true);

    const bobSees = await bob.syncGroup("demo");
    expect(bobSees.map((m) => m.content)).toEqual(["two"]);
    // The gate: the pre-switch record is counted via the cut closure (§7.1),
    // the post-switch record via the open stream. Full history, no gaps.
    expect(bob.listMessages("demo").map((m) => m.content)).toEqual([
      "one",
      "two",
    ]);

    // Return trip: a second handoff back to coordinator 1 (a fresh segment
    // on a continuing line — §5).
    await bob.switchCoordinator("demo", bobTarget1);
    const returnRouting = bob.getGroup("demo").metadata?.coordinatorRouting;
    expect(returnRouting?.boundaryTips).toEqual([one.id, two.id]);
    expect(returnRouting?.active.pubkey.toLowerCase()).toBe(
      harness.server1Pubkey.toLowerCase(),
    );
    await alice.syncGroup("demo");
    expect(alice.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server1Pubkey.toLowerCase(),
    );

    await bob.sendMessage("demo", "three");
    const aliceSync = await alice.syncGroup("demo");
    // Re-reads of coordinator 1's line dedupe by envelope id (§6.2): alice
    // sees only the new record even though her fetch re-reads old cursors.
    expect(aliceSync.map((m) => m.content)).toEqual(["three"]);
    expect(alice.listMessages("demo").map((m) => m.content)).toEqual([
      "one",
      "two",
      "three",
    ]);
  }, 15_000);

  test("a late write to the closing stream is orphaned at the cut, rescued by its author's re-linking, and re-sent to heal the gap it leaves", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice, target2 } = harness.makeSession();
    const { session: bob } = harness.makeSession();

    await bootstrapGroup(alice, bob, harness);
    await alice.switchCoordinator("demo", target2);

    // Bob's device is behind the cut and writes to the closing coordinator.
    const stale = await postStaleOutbound({
      session: bob,
      relayHub: harness.relayHub,
      serverPubkey: harness.server1Pubkey,
      content: "late",
    });
    // Provisionally counted on his own stream before he learns of the cut.
    expect(bob.listMessages("demo").map((m) => m.content)).toEqual([
      "one",
      "late",
    ]);

    // Catching up processes the cut, then the same batch carries his late
    // write past it: it flips to orphaned and stays unprocessed (§13) while
    // remaining held for rescue (§7.2).
    const bobSync = await bob.syncGroup("demo");
    expect(bobSync).toEqual([]);
    expect(bob.listMessages("demo").map((m) => m.content)).toEqual(["one"]);
    expect(bob.getGroup("demo").messages.map((m) => m.content)).toContain(
      "late",
    );

    // §13: the author's next record links the orphan's id — it is counted.
    const rescue = await bob.sendMessage("demo", "rescue");
    expect(rescue.tags.some((t) => t[0] === "prev" && t[1] === stale.id)).toBe(
      true,
    );
    expect(bob.listMessages("demo").map((m) => m.content)).toEqual([
      "one",
      "late",
      "rescue",
    ]);

    // Gaps are soft (§8): alice processes the linked record even though its
    // parent is unknown to her.
    const aliceSync = await alice.syncGroup("demo");
    expect(aliceSync.map((m) => m.content)).toEqual(["rescue"]);
    expect(alice.listMessages("demo").map((m) => m.content)).toEqual([
      "one",
      "rescue",
    ]);

    // §7.2: the orphan must be re-fetched or re-sent before it can be
    // counted elsewhere. The author re-sends the identical envelope (§6.2).
    await bob.resendMessage("demo", stale.id);
    const healed = await alice.syncGroup("demo");
    expect(healed.map((m) => m.content)).toEqual(["late"]);
    expect(alice.listMessages("demo").map((m) => m.content)).toEqual([
      "one",
      "rescue",
      "late",
    ]);

    // Bob re-reads his own re-send: deduplicated by id (§6.2), one record.
    const bobEcho = await bob.syncGroup("demo");
    expect(bobEcho).toEqual([]);
    expect(bob.listMessages("demo").map((m) => m.content)).toEqual([
      "one",
      "late",
      "rescue",
    ]);

    // Re-sends are author-only: the envelope pubkey must match the sender.
    await expect(bob.resendMessage("demo", one1Id(alice))).rejects.toThrow(
      "Only the author",
    );
  }, 15_000);

  test("unplanned failover: the approximate cut, roster discovery, and re-send healing of the dead tail", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice, target2 } = harness.makeSession();
    const { session: bob } = harness.makeSession();

    const one = await bootstrapGroup(alice, bob, harness);

    // Bob's write lands on the closing coordinator and alice never ingests it
    // before the coordinator becomes unreachable (§10.1: policy-level).
    const late = await bob.sendMessage("demo", "late");

    // §10: a forced failover skips the closing stream entirely.
    const { cursor: cutCursor } = await alice.switchCoordinator(
      "demo",
      target2,
      { failover: true },
    );
    // §10.4: the commit is the new segment's first counted record.
    expect(cutCursor).toBe(1);
    // The old segment's cut is approximate: it states what one member had
    // confirmed, and the unseen tail is not in it.
    const routing = alice.getGroup("demo").metadata?.coordinatorRouting;
    expect(routing?.boundaryTips).toContain(one.id);
    expect(routing?.boundaryTips).not.toContain(late.id);

    // §10.2: the stranded member attempts the roster and adopts the
    // coordinator carrying the routing state.
    const adopted = await bob.discoverCoordinator("demo");
    expect(adopted?.toLowerCase()).toBe(harness.server2Pubkey.toLowerCase());
    expect(bob.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );

    // Chat continues; the confirmed history counts via the approximate cut,
    // while the dead tail stays unprocessed (orphaned) on bob's side.
    await alice.sendMessage("demo", "two");
    const bobSees = await bob.syncGroup("demo");
    expect(bobSees.map((m) => m.content)).toEqual(["two"]);
    expect(bob.listMessages("demo").map((m) => m.content)).toEqual([
      "one",
      "two",
    ]);

    // §10.6: the author re-sends the dead tail's identical envelope (§6.2).
    // The fresh copy's stream is provenance the record adopts (§7.2).
    await bob.resendMessage("demo", late.id);
    const bobResent = await bob.syncGroup("demo");
    expect(bobResent.map((m) => m.content)).toEqual(["late"]);
    expect(bob.listMessages("demo").map((m) => m.content)).toEqual([
      "one",
      "late",
      "two",
    ]);

    // The far side heals by the same record.
    const healed = await alice.syncGroup("demo");
    expect(healed.map((m) => m.content)).toEqual(["late"]);
    expect(alice.listMessages("demo").map((m) => m.content)).toEqual([
      "one",
      "two",
      "late",
    ]);
  }, 15_000);

  test("forced failover to a never-used coordinator: the roster names it, and discovery walks past empty fallbacks in preference order", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice, target3 } = harness.makeSession();
    const { session: bob } = harness.makeSession();

    await bootstrapGroup(alice, bob, harness);

    // The group has never used coordinators 2 or 3; the roster must still
    // name them (§4.4) or first-time failover targets are undiscoverable.
    await alice.switchCoordinator("demo", target3, { failover: true });
    const fallbacks =
      alice
        .getGroup("demo")
        .metadata?.coordinatorRouting?.fallbacks.map((f) =>
          f.pubkey.toLowerCase(),
        ) ?? [];
    expect(fallbacks).toEqual([
      harness.server1Pubkey.toLowerCase(),
      harness.server2Pubkey.toLowerCase(),
    ]);

    // Bob walks the roster in preference order (§10.2): coordinator 2 is
    // reachable but empty (skipped); coordinator 3 carries the commit.
    const adopted = await bob.discoverCoordinator("demo");
    expect(adopted?.toLowerCase()).toBe(harness.server3Pubkey.toLowerCase());

    await alice.sendMessage("demo", "two");
    const bobSees = await bob.syncGroup("demo");
    expect(bobSees.map((m) => m.content)).toEqual(["two"]);
    expect(bob.listMessages("demo").map((m) => m.content)).toEqual([
      "one",
      "two",
    ]);
  }, 15_000);

  test("send-window race: concurrent sends are siblings, and the next send links both tips", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice } = harness.makeSession();
    const { session: bob } = harness.makeSession();
    const one = await bootstrapGroup(alice, bob, harness);
    const prev = (m: { tags: string[][] }) =>
      m.tags.filter((tag) => tag[0] === "prev").map((tag) => tag[1]);

    // Bob's record lands in the window before alice ingests it (§6.3): both
    // authors linked only what they had seen, so the records are siblings.
    const a = await alice.sendMessage("demo", "a");
    const late = await postStaleOutbound({
      session: bob,
      relayHub: harness.relayHub,
      serverPubkey: harness.server1Pubkey,
      content: "b",
    });
    expect(prev(a)).toEqual([one.id]);
    expect(prev(bob.getGroup("demo").messages.at(-1)!)).toEqual([one.id]);
    void late;

    // Siblings are first-class (§6.3): both count, and the next send links
    // both tips, collapsing the fork.
    await alice.syncGroup("demo");
    const c = await alice.sendMessage("demo", "c");
    expect(new Set(prev(c))).toEqual(new Set([a.id, late.id]));
    expect(alice.listMessages("demo").map((m) => m.content)).toEqual(
      expect.arrayContaining(["a", "b", "c"]),
    );

    await bob.syncGroup("demo");
    expect(bob.listMessages("demo").map((m) => m.content)).toEqual(
      expect.arrayContaining(["a", "b", "c"]),
    );
  }, 15_000);

  test("same-fallback racing failover: the later committer ingests the target first, so the race serializes (§10)", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice, target2 } = harness.makeSession();
    const { session: bob, target2: bobTarget2 } = harness.makeSession();
    const one = await bootstrapGroup(alice, bob, harness);

    // alice fails over first. bob is stale and races her with the same
    // target: his call runs before he has ingested anything.
    await alice.switchCoordinator("demo", target2, { failover: true });
    await expect(
      bob.switchCoordinator("demo", bobTarget2, { failover: true }),
    ).rejects.toThrow(/already on that coordinator/);

    // Serialized: one commit, one cut, one switch.
    expect(
      bob.getGroup("demo").metadata?.coordinatorRouting?.boundaryTips,
    ).toEqual([one.id]);
    expect(bob.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );

    // Current members survive the race: chat continues on the new one.
    await alice.sendMessage("demo", "two");
    expect((await bob.syncGroup("demo")).map((m) => m.content)).toEqual([
      "two",
    ]);
  }, 15_000);

  test("failover prevention: a rival failover commit anywhere in the roster wins over the member's chosen target — no fork is created (§10)", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice, target3: aliceTarget3 } = harness.makeSession();
    const { session: bob, target2: bobTarget2 } = harness.makeSession();
    const one = await bootstrapGroup(alice, bob, harness);

    // bob fails over to the first fallback. alice, unaware, aims at the
    // second — the roster probe finds bob's commit and adopts it instead.
    await bob.switchCoordinator("demo", bobTarget2, { failover: true });
    await expect(
      alice.switchCoordinator("demo", aliceTarget3, { failover: true }),
    ).rejects.toThrow(/already failed over/);

    // No fork: alice landed on bob's commit (the higher-preference carrier),
    // and nothing was committed to her chosen target.
    expect(alice.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );
    expect(
      alice.getGroup("demo").metadata?.coordinatorRouting?.boundaryTips,
    ).toEqual([one.id]);

    // The group carries on as one.
    await bob.sendMessage("demo", "two");
    expect((await alice.syncGroup("demo")).map((m) => m.content)).toEqual([
      "two",
    ]);
  }, 15_000);

  test("equal-epoch fork: a blind commit to the lower-preference fallback loses — discovery converges on the higher-preference carrier (§10)", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice, target2 } = harness.makeSession();
    const { session: bob } = harness.makeSession();
    const { session: carol } = harness.makeSession();
    await bootstrapGroup(alice, bob, harness);
    await carol.generateKeyPackage("carol-main");
    const invitation = await alice.addMember("demo", carol.stablePubkey);
    await alice.syncGroup("demo");
    await carol.fetchWelcomes();
    await carol.acceptWelcome(invitation.keyPackageReference, "demo");
    await bob.syncGroup("demo");

    // alice fails over to the first fallback. bob's stale device never
    // ingests it and blind-commits to the second — two equal-epoch handoff
    // commits on different coordinators (§10).
    await alice.switchCoordinator("demo", target2, { failover: true });
    await postStaleRoutingCommit({
      session: bob,
      relayHub: harness.relayHub,
      serverPubkey: harness.server3Pubkey,
      routing: {
        active: { pubkey: harness.server3Pubkey.toLowerCase(), relayUrls: [] },
        fallbacks: [
          { pubkey: harness.server1Pubkey.toLowerCase(), relayUrls: [] },
          { pubkey: harness.server2Pubkey.toLowerCase(), relayUrls: [] },
        ],
        boundaryTips: [],
      },
    });

    // A stranded member probes the roster in preference order and converges
    // on the branch carried by the higher-preference coordinator — the §10
    // winner rule. The loser's branch is never adopted.
    const adopted = await carol.discoverCoordinator("demo");
    expect(adopted?.toLowerCase()).toBe(harness.server2Pubkey.toLowerCase());
    expect(carol.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );

    // The winner's branch keeps working; the loser's records never count.
    await alice.sendMessage("demo", "winner");
    expect((await carol.syncGroup("demo")).map((m) => m.content)).toEqual([
      "winner",
    ]);
  }, 15_000);

  test("probe liveness: one failed probe must not condemn a live coordinator (§10 step 1)", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice } = harness.makeSession();
    const { session: bob, target2: bobTarget2 } = harness.makeSession();
    await bootstrapGroup(alice, bob, harness);
    await bob.switchCoordinator("demo", bobTarget2, { failover: true });

    // alice's first probe of the new home fails transiently — without the
    // retry she would condemn a live coordinator and land nowhere.
    const registry = (
      alice as unknown as {
        coordinatorRegistry: { getClient(key?: string): cordnClient };
      }
    ).coordinatorRegistry;
    const client = registry.getClient(harness.server2Pubkey);
    const original = client.FetchManyGroupMessages.bind(client);
    let failed = false;
    client.FetchManyGroupMessages = (request) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error("transient network error"));
      }
      return original(request);
    };

    const adopted = await alice.discoverCoordinator("demo");
    expect(failed).toBe(true);
    expect(adopted?.toLowerCase()).toBe(harness.server2Pubkey.toLowerCase());
  }, 15_000);

  test("real coordinator loss: sync recovers through the roster and the group carries on (§10)", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice, target2 } = harness.makeSession();
    const { session: bob } = harness.makeSession();
    await bootstrapGroup(alice, bob, harness);

    // server1 dies: its transport refuses everything.
    await harness.stopServer1();

    // An admin failovers; a stranded member's sync recovers via the roster.
    await alice.switchCoordinator("demo", target2, { failover: true });
    await bob.syncGroup("demo");
    expect(bob.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );

    // The group carries on as one.
    await alice.sendMessage("demo", "after-loss");
    expect((await bob.syncGroup("demo")).map((m) => m.content)).toEqual([
      "after-loss",
    ]);
  }, 15_000);

  test("a routing update outside the roster is void on receipt, and the author client refuses to build one (§4.4, §14)", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice } = harness.makeSession();
    const { session: bob } = harness.makeSession();
    await bootstrapGroup(alice, bob, harness);
    const rogue = { pubkey: "44".repeat(32), relayUrls: [] };

    // §4.4 binds update authors: the honest client refuses outright.
    await expect(
      alice.updateGroupMetadata("demo", {
        name: "demo",
        coordinatorRouting: {
          active: rogue,
          fallbacks: [
            { pubkey: harness.server2Pubkey.toLowerCase(), relayUrls: [] },
          ],
          boundaryTips: [],
        },
      }),
    ).rejects.toThrow(/not a declared fallback/);

    // A modified client builds and posts the void update anyway — recipients
    // discard the routing change (the rest of the metadata still applies).
    await postStaleRoutingCommit({
      session: alice,
      relayHub: harness.relayHub,
      serverPubkey: harness.server1Pubkey,
      routing: {
        active: rogue,
        fallbacks: [
          { pubkey: harness.server2Pubkey.toLowerCase(), relayUrls: [] },
        ],
        boundaryTips: [],
      },
    });
    await bob.syncGroup("demo");

    expect(bob.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server1Pubkey.toLowerCase(),
    );
    expect(
      bob.getGroup("demo").metadata?.coordinatorRouting?.active.pubkey,
    ).toBe(harness.server1Pubkey.toLowerCase());
    expect(
      bob
        .getGroup("demo")
        .syncIssues.some((issue) => /Void routing update/.test(issue.detail)),
    ).toBe(true);
  }, 15_000);

  test("a metadata edit may move active within the roster — handoff by another name (§4.4)", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice } = harness.makeSession();
    const { session: bob } = harness.makeSession();
    const one = await bootstrapGroup(alice, bob, harness);

    await alice.updateGroupMetadata("demo", {
      name: "demo",
      coordinatorRouting: {
        active: { pubkey: harness.server2Pubkey.toLowerCase(), relayUrls: [] },
        fallbacks: [
          { pubkey: harness.server1Pubkey.toLowerCase(), relayUrls: [] },
          { pubkey: harness.server3Pubkey.toLowerCase(), relayUrls: [] },
        ],
        boundaryTips: [one.id],
      },
    });

    await bob.syncGroup("demo");
    expect(bob.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );
    await alice.sendMessage("demo", "moved");
    expect((await bob.syncGroup("demo")).map((m) => m.content)).toEqual([
      "moved",
    ]);
  }, 15_000);

  test("live watch survives the handoff: backlog replay and live delivery on the new active (§9 step 6)", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice, target2 } = harness.makeSession();
    const { session: bob } = harness.makeSession();
    await bootstrapGroup(alice, bob, harness);
    await bob.watchGroup("demo");
    expect(bob.getWatchStatus("demo")).toBe("watching");

    await alice.sendMessage("demo", "before");
    await waitForCondition(
      () => bob.listMessages("demo").some((m) => m.content === "before"),
      5_000,
    );

    await alice.switchCoordinator("demo", target2, {});
    await alice.sendMessage("demo", "after");

    // The watch restarts on the new active and replays its backlog, then
    // delivers live (§9 step 6).
    await waitForCondition(
      () => bob.listMessages("demo").some((m) => m.content === "after"),
      5_000,
    );
    expect(bob.getWatchStatus("demo")).toBe("watching");
    expect(bob.listMessages("demo").map((m) => m.content)).toEqual(
      expect.arrayContaining(["before", "after"]),
    );
    expect(bob.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );
  }, 15_000);

  test("welcomes do not migrate: a stranded invitation is lost, its owner starts over on the active (§11)", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice, target2 } = harness.makeSession();
    const { session: bob } = harness.makeSession();
    const { session: carol } = harness.makeSession();
    await bootstrapGroup(alice, bob, harness);
    await carol.generateKeyPackage("carol-main");
    await alice.addMember("demo", carol.stablePubkey);
    await alice.syncGroup("demo");

    // The old coordinator dies with the Welcome on it.
    await harness.stopServer1();
    await alice.switchCoordinator("demo", target2, { failover: true });

    // Not migrated: the dead coordinator is unreachable and the new active
    // holds nothing for carol.
    await expect(carol.fetchWelcomes()).rejects.toThrow();
    expect(await carol.fetchWelcomes(harness.server2Pubkey)).toEqual([]);

    // The owner starts over: an ordinary addMember on the active coordinator.
    await carol.generateKeyPackage("carol-main-2", {
      coordinatorKey: harness.server2Pubkey,
    });
    const invitation = await alice.addMember("demo", carol.stablePubkey);
    await alice.syncGroup("demo");
    await carol.fetchWelcomes(harness.server2Pubkey);
    await carol.acceptWelcome(invitation.keyPackageReference, "demo");

    // The invitee learned the routing from the Welcome itself (§11).
    expect(carol.getGroup("demo").coordinatorKey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );
  }, 15_000);

  test("a group with no declared roster cannot hand off (§4.4)", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { session: alice, target2 } = harness.makeSession();
    await alice.generateKeyPackage("alice-main");
    await alice.createGroup("plain", {
      keyPackageAlias: "alice-main",
      metadata: { name: "plain" },
    });

    await expect(
      alice.switchCoordinator("plain", target2, { failover: true }),
    ).rejects.toThrow(/no declared fallback roster/);
  }, 15_000);
});

/** alice's first chat record id, for the author-only re-send check. */
function one1Id(alice: CliSession): string {
  const first = alice.listMessages("demo").find((m) => m.content === "one");
  if (!first) throw new Error("missing bootstrap message");
  return first.id;
}
