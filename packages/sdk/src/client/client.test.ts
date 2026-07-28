import { describe, expect, test } from "vitest";

import { getCordnGroupMetadataExtension } from "@cordn/core";
import { getTestCiphersuite } from "@cordn/test-utils";

import { findMemberLeafIndexByStablePubkey } from "../engine/members.ts";
import { InMemoryKeyValueStore } from "../extra/inMemoryStore.ts";
import { CordnClient } from "./client.ts";
import {
  proposeAddMember,
  proposeRemoveMember,
  proposeUpdateMetadata,
} from "./proposals.ts";
import { createInProcessTransport } from "../testing/inProcessTransport.ts";
import { createPrivateKeySigner } from "../testing/privateKeySigner.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function newClient(
  transport: ReturnType<typeof createInProcessTransport>["transport"],
) {
  const cipherSuite = await getTestCiphersuite();
  return new CordnClient({
    signer: createPrivateKeySigner(),
    transport,
    ciphersuite: cipherSuite,
    keyPackageStorage: new InMemoryKeyValueStore(),
  });
}

describe("CordnClient end-to-end", () => {
  test("create → publish → invite → join → message", async () => {
    const { transport } = createInProcessTransport();
    const alice = await newClient(transport);
    const bob = await newClient(transport);

    // Both generate + publish a key package.
    const aliceKp = await alice.keyPackages.generate();
    await alice.keyPackages.publish(aliceKp.keyPackageRef);
    const bobKp = await bob.keyPackages.generate();
    await bob.keyPackages.publish(bobKp.keyPackageRef);

    // Alice creates a group.
    const groupId = "group-e2e";
    const aliceGroup = await alice.groups.create({
      groupId,
      metadata: { name: "e2e demo" },
    });

    // Alice consumes Bob's published key package and adds him.
    const bobPublished = await alice.keyPackages.consume(bobKp.keyPackageRef);
    await aliceGroup.commit([proposeAddMember(bobPublished.keyPackage)]);
    // Confirming the commit (self-echo) stores Bob's welcome on the coordinator.
    await aliceGroup.fetch();

    // Bob fetches his welcome and joins.
    const welcomes = await bob.invites.fetch();
    expect(welcomes).toHaveLength(1);
    const welcome = welcomes[0]!;
    const bobGroup = await bob.groups.joinFromWelcome({
      welcome: welcome.welcome,
      keyPackageRef: welcome.keyPackageReference,
      joinAfterCursor: welcome.joinAfterCursor,
    });

    // Alice sends; Bob catches up and decrypts.
    await aliceGroup.send(encoder.encode("welcome to the group"));
    const bobResults = await bobGroup.fetch();
    const processed = bobResults.find((r) => r.disposition === "processed");
    expect(processed).toBeDefined();
    expect(decoder.decode(processed!.applicationMessage!)).toBe(
      "welcome to the group",
    );

    // Bob replies; Alice receives it.
    await bobGroup.send(encoder.encode("thanks!"));
    const aliceResults = await aliceGroup.fetch();
    const reply = aliceResults.find((r) => r.disposition === "processed");
    expect(reply).toBeDefined();
    expect(decoder.decode(reply!.applicationMessage!)).toBe("thanks!");
  });

  test("consuming a published key package returns the bound record", async () => {
    const { transport } = createInProcessTransport();
    const alice = await newClient(transport);
    const bobKp = await alice.keyPackages.generate();
    await alice.keyPackages.publish(bobKp.keyPackageRef);

    // The published package is correctly bound, so consume succeeds.
    const consumed = await alice.keyPackages.consume(bobKp.keyPackageRef);
    expect(consumed.stablePubkey).toBe(bobKp.stablePubkey);
  });

  test("remove a member via proposeRemoveMember; self-removal is blocked", async () => {
    const { transport } = createInProcessTransport();
    const alice = await newClient(transport);
    const bob = await newClient(transport);
    const aliceKp = await alice.keyPackages.generate();
    await alice.keyPackages.publish(aliceKp.keyPackageRef);
    const bobKp = await bob.keyPackages.generate();
    await bob.keyPackages.publish(bobKp.keyPackageRef);

    const aliceGroup = await alice.groups.create({
      groupId: "g-remove",
      metadata: { name: "r" },
    });
    const bobPublished = await alice.keyPackages.consume(bobKp.keyPackageRef);
    await aliceGroup.commit([proposeAddMember(bobPublished.keyPackage)]);
    await aliceGroup.fetch();
    expect(
      findMemberLeafIndexByStablePubkey(
        aliceGroup.engine.state,
        bobKp.stablePubkey,
      ),
    ).toBeGreaterThanOrEqual(0);

    // Self-removal is blocked (web invariant).
    await expect(
      aliceGroup.commit([proposeRemoveMember(aliceKp.stablePubkey)]),
    ).rejects.toThrow(/local member is not supported/);

    // Removing bob succeeds and drops him from the tree.
    await aliceGroup.commit([proposeRemoveMember(bobKp.stablePubkey)]);
    await aliceGroup.fetch();
    expect(
      findMemberLeafIndexByStablePubkey(
        aliceGroup.engine.state,
        bobKp.stablePubkey,
      ),
    ).toBeLessThan(0);
  });

  test("update group metadata via proposeUpdateMetadata", async () => {
    const { transport } = createInProcessTransport();
    const alice = await newClient(transport);
    await alice.keyPackages.publish(
      (await alice.keyPackages.generate()).keyPackageRef,
    );

    const group = await alice.groups.create({
      groupId: "g-meta",
      metadata: { name: "old" },
    });
    await group.commit([proposeUpdateMetadata({ name: "new name" })]);
    await group.fetch();

    expect(getCordnGroupMetadataExtension(group.engine.state)?.name).toBe(
      "new name",
    );
  });

  test("previewWelcome shows metadata + members without joining", async () => {
    const { transport } = createInProcessTransport();
    const alice = await newClient(transport);
    const bob = await newClient(transport);
    const aliceKp = await alice.keyPackages.generate();
    await alice.keyPackages.publish(aliceKp.keyPackageRef);
    const bobKp = await bob.keyPackages.generate();
    await bob.keyPackages.publish(bobKp.keyPackageRef);

    const aliceGroup = await alice.groups.create({
      groupId: "g-preview",
      metadata: { name: "preview-group" },
    });
    const bobPublished = await alice.keyPackages.consume(bobKp.keyPackageRef);
    await aliceGroup.commit([proposeAddMember(bobPublished.keyPackage)]);
    await aliceGroup.fetch();

    const [welcome] = await bob.invites.fetch();
    const preview = await bob.groups.previewWelcome({
      welcome: welcome!.welcome,
      keyPackageRef: welcome!.keyPackageReference,
    });
    expect(preview.name).toBe("preview-group");
    expect(preview.memberPubkeys).toContain(aliceKp.stablePubkey);
    expect(preview.memberPubkeys).toContain(bobKp.stablePubkey);
  });

  test("join request store + fetch round-trip", async () => {
    const { transport } = createInProcessTransport();
    const alice = await newClient(transport);
    const bob = await newClient(transport);
    const bobKp = await bob.keyPackages.generate();
    await bob.keyPackages.publish(bobKp.keyPackageRef);

    await bob.joinRequests.store({
      groupId: "g-jr",
      keyPackageRef: bobKp.keyPackageRef,
    });
    const pending = await alice.joinRequests.fetch("g-jr");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requesterStablePubkey).toBe(bobKp.stablePubkey);
    expect(pending[0]!.keyPackageRef).toBe(bobKp.keyPackageRef);
  });

  test("last-resort key packages are reusable; regular ones are consumed once", async () => {
    const { transport } = createInProcessTransport();
    const alice = await newClient(transport);
    const regular = await alice.keyPackages.generate();
    await alice.keyPackages.publish(regular.keyPackageRef);
    const lastResort = await alice.keyPackages.generate({ lastResort: true });
    await alice.keyPackages.publish(lastResort.keyPackageRef);
    expect(lastResort.isLastResort).toBe(true);

    // Regular: consumed once, then gone.
    const regularFirst = await alice.keyPackages.consume(regular.keyPackageRef);
    expect(regularFirst.keyPackageRef).toBe(regular.keyPackageRef);
    await expect(
      alice.keyPackages.consume(regular.keyPackageRef),
    ).rejects.toThrow(/not found/);

    // Last-resort: reusable across consumes (gotcha #7).
    const lr1 = await alice.keyPackages.consume(lastResort.keyPackageRef);
    const lr2 = await alice.keyPackages.consume(lastResort.keyPackageRef);
    expect(lr1.keyPackageRef).toBe(lastResort.keyPackageRef);
    expect(lr2.keyPackageRef).toBe(lastResort.keyPackageRef);
  });
});
