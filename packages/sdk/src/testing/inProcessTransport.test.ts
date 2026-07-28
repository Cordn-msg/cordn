import { describe, expect, test } from "vitest";

import { createThreeActorGroupScenario } from "@cordn/test-utils";

import { createInProcessTransport } from "./inProcessTransport.ts";

describe("InProcessTransport", () => {
  test("posts and fetches group messages with per-group cursors", async () => {
    const { transport } = createInProcessTransport();

    const first = await transport.postGroupMessage({
      groupId: "group-a",
      opaqueMessage: new Uint8Array([1, 2, 3]),
    });
    expect(first.cursor).toBe(1);
    expect(first.groupId).toBe("group-a");

    const second = await transport.postGroupMessage({
      groupId: "group-a",
      opaqueMessage: new Uint8Array([4, 5, 6]),
    });
    expect(second.cursor).toBe(2);

    // a different group has an independent cursor
    const other = await transport.postGroupMessage({
      groupId: "group-b",
      opaqueMessage: new Uint8Array([9]),
    });
    expect(other.cursor).toBe(1);

    const all = await transport.fetchGroupMessages({ groupId: "group-a" });
    expect(all).toHaveLength(2);
    expect(all[0]!.opaqueMessage).toEqual(new Uint8Array([1, 2, 3]));

    const afterFirst = await transport.fetchGroupMessages({
      groupId: "group-a",
      afterCursor: 1,
    });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.cursor).toBe(2);
  });

  test("stores and fetches a pending welcome", async () => {
    const scenario = await createThreeActorGroupScenario();
    const { transport } = createInProcessTransport();

    await transport.storeWelcome({
      targetStablePubkey: scenario.bob.actor.stablePubkey,
      keyPackageReference: scenario.bobKeyPackageRef,
      welcome: scenario.bobWelcome,
      joinAfterCursor: 5,
    });

    const pending = await transport.fetchPendingWelcomes(
      scenario.bob.actor.stablePubkey,
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.keyPackageReference).toBe(scenario.bobKeyPackageRef);
    expect(pending[0]!.joinAfterCursor).toBe(5);
  });
});
