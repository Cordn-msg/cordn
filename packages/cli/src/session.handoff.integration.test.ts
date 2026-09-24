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
import { decodeBase64 } from "./utils/mlsBase.ts";
import { createPrivateKeyHex } from "./utils/mlsIdentity.ts";
import { connectServer } from "@cordn/server";
import { MockRelayHub } from "@cordn/test-utils";
import { PrivateKeySigner } from "@contextvm/sdk";

/** Coordinator handoff end-to-end (spec/applications/coordinator-handoff.md):
 * two real coordinators, real MLS groups, planned handoffs, the counted-history
 * gate, late writes to a closing stream, author rescue by re-linking, and
 * §6.2 re-sends healing gaps. */

interface Harness {
  relayHub: MockRelayHub;
  server1Pubkey: string;
  server2Pubkey: string;
  makeSession: () => {
    session: CliSession;
    target1: CoordinatorTarget;
    target2: CoordinatorTarget;
  };
  close: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const relayHub = new MockRelayHub();
  const signer1 = new PrivateKeySigner();
  const signer2 = new PrivateKeySigner();
  const server1Pubkey = await signer1.getPublicKey();
  const server2Pubkey = await signer2.getPublicKey();
  const servers = await Promise.all([
    connectServer({
      signer: signer1,
      relayHandler: relayHub.createRelayHandler(),
    }),
    connectServer({
      signer: signer2,
      relayHandler: relayHub.createRelayHandler(),
    }),
  ]);
  const sessions: CliSession[] = [];
  const clients: cordnClient[] = [];

  return {
    relayHub,
    server1Pubkey,
    server2Pubkey,
    makeSession() {
      const target1: CoordinatorTarget = {
        serverPubkey: server1Pubkey,
        relayHandler: relayHub.createRelayHandler(),
      };
      const target2: CoordinatorTarget = {
        serverPubkey: server2Pubkey,
        relayHandler: relayHub.createRelayHandler(),
      };
      const session = new CliSession({
        defaultCoordinator: target1,
        coordinators: { [server2Pubkey]: target2 },
      });
      sessions.push(session);
      return { session, target1, target2 };
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

async function bootstrapGroup(
  alice: CliSession,
  bob: CliSession,
): Promise<{ id: string; cursor: number }> {
  await alice.generateKeyPackage("alice-main");
  await bob.generateKeyPackage("bob-main");
  await alice.createGroup("demo", {
    keyPackageAlias: "alice-main",
    metadata: { name: "demo" },
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

    const one = await bootstrapGroup(alice, bob);

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
    expect(routing?.handoffs).toHaveLength(1);
    expect(routing?.handoffs[0]?.from.pubkey.toLowerCase()).toBe(
      harness.server1Pubkey.toLowerCase(),
    );
    expect(routing?.handoffs[0]?.boundaryTips).toContain(one.id);
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
      bob.getGroup("demo").metadata?.coordinatorRouting?.handoffs,
    ).toHaveLength(1);

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
    expect(returnRouting?.handoffs).toHaveLength(2);
    expect(returnRouting?.handoffs[1]?.from.pubkey.toLowerCase()).toBe(
      harness.server2Pubkey.toLowerCase(),
    );
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

    await bootstrapGroup(alice, bob);
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
});

/** alice's first chat record id, for the author-only re-send check. */
function one1Id(alice: CliSession): string {
  const first = alice.listMessages("demo").find((m) => m.content === "one");
  if (!first) throw new Error("missing bootstrap message");
  return first.id;
}
