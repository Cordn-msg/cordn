import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

import { CliSession } from "./session.ts";
import { NostrTipStore } from "./nostrTipStore.ts";
import { FileMediaStore } from "./mediaStore.ts";
import type { MediaStore } from "./mediaStore.ts";
import { connectServer } from "@cordn/server";
import { MockRelayHub } from "@cordn/test-utils";
import { PrivateKeySigner } from "@contextvm/sdk";
import {
  publishGroupDocument,
  publishMetaDocument,
  pullDocument,
  reconcileGroupDocument,
  reconcileMetaDocument,
  walkGroupChain,
  MULTI_DEVICE_SCHEMA_VERSION,
  type GroupDocument,
  type MetaDocument,
} from "./multiDevice.ts";
import { clientStateEncoder, encode } from "ts-mls";
import { getCordnGroupMetadataExtension } from "./groupMetadata.ts";

/**
 * Multi-device synchronization scenarios (spec/applications/multi-device.md).
 *
 * One in-process coordinator (MockRelayHub + connectServer) and a shared
 * FileMediaStore as the Blossom stand-in. Two CliSessions sharing one
 * `privateKey` emulate two devices of one identity on a single shared MLS leaf.
 *
 * Convergence model validated here:
 *  - Application messages between siblings converge via the delivery stream.
 *  - A sibling device's Commit CANNOT be ingested via the stream (the shared
 *    leaf's UpdatePath invalidates the receiving device's keys). The committing
 *    device re-publishes that group's document; the sibling fast-forwards its
 *    ClientState to the newer epoch.
 *
 * The redesigned model (per-group documents + one meta document, spec §4) is
 * exercised throughout: group convergence uses `publishGroupDocument` /
 * `reconcileGroupDocument`; tombstones and the last-resort key package travel
 * in the meta document (`publishMetaDocument` / `reconcileMetaDocument`).
 */
describe("multi-device synchronization", () => {
  const sessions: CliSession[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      sessions.splice(0).map((session) => session.disconnect()),
    );
  });

  /** Pull a group document by address, narrowing the union (spec §4.1). */
  const pullGroupDoc = async (
    session: CliSession,
    address: string,
    mediaStore: MediaStore,
    addressToUrl: (address: string) => string,
  ): Promise<GroupDocument> => {
    const doc = await pullDocument({
      address,
      mediaStore,
      addressToUrl,
      privateKeyHex: session.privateKey,
      ownerPubkey: session.stablePubkey,
    });
    if (doc.type !== "group") throw new Error("expected group document");
    return doc;
  };

  /** Pull a meta document by address, narrowing the union (spec §4.2). */
  const pullMetaDoc = async (
    session: CliSession,
    address: string,
    mediaStore: MediaStore,
    addressToUrl: (address: string) => string,
  ): Promise<MetaDocument> => {
    const doc = await pullDocument({
      address,
      mediaStore,
      addressToUrl,
      privateKeyHex: session.privateKey,
      ownerPubkey: session.stablePubkey,
    });
    if (doc.type !== "meta") throw new Error("expected meta document");
    return doc;
  };

  /**
   * Scenario A — application messages converge via the stream after a seed.
   *
   * Device 1 creates a group and publishes BEFORE sending, so the seeded
   * ClientState precedes the messages. Device 2 seeds the shared leaf, then
   * receives every message device 1 subsequently posts — purely through the
   * normal delivery stream, no re-seed needed. Device 2 then sends and device
   * 1 receives, proving the shared leaf is bidirectional.
   */
  test("seeds a shared leaf and converges on application messages via the stream", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const mediaStore = new FileMediaStore(
      await mkdtemp(join(tmpdir(), "cordn-md-a-")),
    );
    const addressToUrl = (address: string) => `media://${address}`;
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(alice);
      await alice.generateKeyPackage("kp", { localOnly: true });
      await alice.createGroup("demo", {
        keyPackageAlias: "kp",
        metadata: { name: "Demo" },
      });
      const gid = alice.deriveGroupId(alice.getGroup("demo").state);

      // Publish BEFORE sending so the seed state precedes the messages.
      const pub = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });
      expect(pub.address).toHaveLength(64);

      const device2 = new CliSession({
        privateKey: alice.privateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(device2);
      expect(device2.stablePubkey).toBe(alice.stablePubkey);
      expect(device2.listGroups()).toHaveLength(0);

      const doc = await pullGroupDoc(
        device2,
        pub.address,
        mediaStore,
        addressToUrl,
      );
      expect(await reconcileGroupDocument(device2, doc)).toBe("seeded");
      const d2alias = device2.listGroups()[0]!.alias;

      // Same shared leaf (delivery group id).
      expect(device2.deriveGroupId(device2.getGroup(d2alias).state)).toBe(gid);

      // Now alice sends; device 2 receives purely via the stream.
      await alice.sendMessage("demo", "hello");
      await alice.sendMessage("demo", "world");
      const received = await device2.syncGroup(d2alias);
      expect(received.map((m) => m.content)).toEqual(["hello", "world"]);

      // Replaying the same document must not re-seed or overwrite (spec §8).
      expect(await reconcileGroupDocument(device2, doc)).toBe("skipped");

      // Shared leaf is bidirectional: device 2 sends, device 1 receives.
      await device2.sendMessage(d2alias, "hi from device2");
      await alice.syncGroup("demo");
      expect(alice.listMessages("demo").map((m) => m.content)).toContain(
        "hi from device2",
      );
    } finally {
      await server.transport.close();
    }
  });

  /**
   * Scenario C — a sibling Commit converges via document fast-forward.
   *
   * Device 1 commits (metadata update). Device 2 cannot ingest that Commit
   * from the stream (shared-leaf UpdatePath), so device 1 re-publishes and
   * device 2 fast-forwards its ClientState to the newer epoch. Both devices
   * end on the same epoch, same metadata, byte-identical ClientState. A
   * post-commit application message then round-trips between them, proving the
   * shared leaf is intact at the new epoch.
   *
   * This is the load-bearing convergence path for the shared-leaf model
   * (spec §10): application messages and third-party Commits converge via the
   * stream; sibling Commits converge via document fast-forward.
   */
  test("a sibling commit converges via document fast-forward, not stream ingestion", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const mediaStore = new FileMediaStore(
      await mkdtemp(join(tmpdir(), "cordn-md-c-")),
    );
    const addressToUrl = (address: string) => `media://${address}`;
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(alice);
      await alice.generateKeyPackage("kp", { localOnly: true });
      const group = await alice.createGroup("g", {
        keyPackageAlias: "kp",
        metadata: { name: "Original" },
      });
      const gid = alice.deriveGroupId(group.state);
      const baseEpoch = group.state.groupContext.epoch;

      const pub0 = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });
      const device2 = new CliSession({
        privateKey: alice.privateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(device2);
      const doc0 = await pullGroupDoc(
        device2,
        pub0.address,
        mediaStore,
        addressToUrl,
      );
      await reconcileGroupDocument(device2, doc0);
      const d2alias = device2.listGroups()[0]!.alias;
      expect(device2.getGroup(d2alias).state.groupContext.epoch).toBe(
        baseEpoch,
      );

      // Device 1 commits and re-publishes. It syncs first so its fetch cursor
      // advances past its own Commit before the document is written, which
      // keeps device 2's fast-forward cursor ahead of the Commit too (so the
      // Commit is never fetched back over the stream by device 2).
      await alice.updateGroupMetadata("g", { name: "FromAlice" });
      await alice.syncGroup("g");
      const pub1 = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });

      // Device 2 fast-forwards from the new document (no stream sync).
      const doc1 = await pullGroupDoc(
        device2,
        pub1.address,
        mediaStore,
        addressToUrl,
      );
      expect(await reconcileGroupDocument(device2, doc1)).toBe(
        "fast-forwarded",
      );

      const aliceState = alice.getGroup("g").state;
      const d2State = device2.getGroup(d2alias).state;

      // Same epoch, canonical metadata, byte-identical tree (full state copy).
      expect(d2State.groupContext.epoch).toBe(aliceState.groupContext.epoch);
      expect(aliceState.groupContext.epoch).toBe(baseEpoch + 1n);
      expect(getCordnGroupMetadataExtension(aliceState)?.name).toBe(
        "FromAlice",
      );
      expect(getCordnGroupMetadataExtension(d2State)?.name).toBe("FromAlice");
      expect(encode(clientStateEncoder, d2State)).toEqual(
        encode(clientStateEncoder, aliceState),
      );

      // A document at the same or older epoch must NOT fast-forward (rollback
      // defense, spec §8): replaying the old document is a no-op.
      expect(await reconcileGroupDocument(device2, doc0)).toBe("skipped");

      // Post-commit application messages still converge via the stream.
      await alice.sendMessage("g", "post-commit");
      await device2.syncGroup(d2alias);
      const postCommit = device2
        .listMessages(d2alias)
        .find((m) => m.content === "post-commit");
      expect(postCommit?.sender).toBe(alice.stablePubkey);

      await device2.sendMessage(d2alias, "back-at-you");
      await alice.syncGroup("g");
      expect(alice.listMessages("g").map((m) => m.content)).toContain(
        "back-at-you",
      );
    } finally {
      await server.transport.close();
    }
  });

  /**
   * Scenario D — the sibling-skip guard (spec/applications/multi-device.md
   * §10). This is the load-bearing test for the ingestion guard.
   *
   * Device 2 is online and seeded. Device 1 commits (metadata update) and the
   * Commit arrives at device 2 OVER THE STREAM. Without the guard, device 2
   * tries to process its own leaf's Commit, the UpdatePath invalidates its
   * keys, and ts-mls throws — which the old code interpreted as "I was
   * removed" → device 2 marked itself `removed`. The guard detects (via the
   * sender leaf index captured in the authorization callback) that the Commit
   * came from device 2's own shared leaf and skips it, staying active. Device 2
   * then fast-forwards via the document.
   */
  test("a sibling commit arriving over the stream is skipped, not treated as a self-removal", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const mediaStore = new FileMediaStore(
      await mkdtemp(join(tmpdir(), "cordn-md-d-")),
    );
    const addressToUrl = (address: string) => `media://${address}`;
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(alice);
      await alice.generateKeyPackage("kp", { localOnly: true });
      const group = await alice.createGroup("g", {
        keyPackageAlias: "kp",
        metadata: { name: "Original" },
      });
      const gid = alice.deriveGroupId(group.state);
      const baseEpoch = group.state.groupContext.epoch;

      // Seed device 2 at the base epoch.
      const pub0 = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });
      const device2 = new CliSession({
        privateKey: alice.privateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(device2);
      const doc0 = await pullGroupDoc(
        device2,
        pub0.address,
        mediaStore,
        addressToUrl,
      );
      await reconcileGroupDocument(device2, doc0);
      const d2alias = device2.listGroups()[0]!.alias;
      expect(device2.getGroup(d2alias).state.groupContext.epoch).toBe(
        baseEpoch,
      );

      // Device 1 commits and confirms via self-echo.
      await alice.updateGroupMetadata("g", { name: "FromAlice" });
      await alice.syncGroup("g");
      expect(alice.getGroup("g").state.groupContext.epoch).toBe(baseEpoch + 1n);

      // Device 2 now syncs: it receives device 1's Commit over the stream.
      // The guard MUST skip it (own shared leaf) instead of self-removing.
      await device2.syncGroup(d2alias);
      const d2group = device2.getGroup(d2alias);
      expect(d2group.status).toBe("active"); // the assertion that used to fail
      expect(d2group.state.groupContext.epoch).toBe(baseEpoch); // unchanged

      // Convergence via the document fast-forward.
      const pub1 = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });
      const doc1 = await pullGroupDoc(
        device2,
        pub1.address,
        mediaStore,
        addressToUrl,
      );
      expect(await reconcileGroupDocument(device2, doc1)).toBe(
        "fast-forwarded",
      );
      expect(device2.getGroup(d2alias).state.groupContext.epoch).toBe(
        baseEpoch + 1n,
      );
      expect(
        getCordnGroupMetadataExtension(device2.getGroup(d2alias).state)?.name,
      ).toBe("FromAlice");
    } finally {
      await server.transport.close();
    }
  });

  /**
   * The auto re-publish hook (`onLocalStateAdvance`) fires when local state
   * advances in a way siblings must learn about: on group creation, and on
   * confirmation of a locally-authored Commit via self-echo.
   */
  test("onLocalStateAdvance fires on group creation and on commit confirmation", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const fired: string[] = [];
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        onLocalStateAdvance: () => {
          fired.push("advance");
        },
      });
      sessions.push(alice);
      await alice.generateKeyPackage("kp", { localOnly: true });

      await alice.createGroup("g", {
        keyPackageAlias: "kp",
        metadata: { name: "G" },
      });
      // createGroup fires the hook (new group for siblings to seed).
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fired).toEqual(["advance"]);

      // A locally-authored Commit does NOT fire until its self-echo confirms.
      await alice.updateGroupMetadata("g", { name: "G2" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fired).toEqual(["advance"]); // not yet confirmed

      await alice.syncGroup("g"); // self-echo confirms the Commit
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fired).toEqual(["advance", "advance"]);
    } finally {
      await server.transport.close();
    }
  });

  /**
   * Scenario E — multi-epoch catch-up (recovery from being offline). A device
   * seeds at epoch 0, then stays offline while the committer advances several
   * epochs. Pulling the latest group document MUST fast-forward across the
   * whole gap in one reconcile (not +1 at a time), land on the correct state
   * and cursor, and leave the shared leaf usable for messages. Existing
   * scenarios only jump a single epoch; this proves the catch-up path scales
   * to a real gap.
   */
  test("an offline device fast-forwards across multiple epochs in one reconcile", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const mediaStore = new FileMediaStore(
      await mkdtemp(join(tmpdir(), "cordn-md-e-")),
    );
    const addressToUrl = (address: string) => `media://${address}`;
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(alice);
      await alice.generateKeyPackage("kp", { localOnly: true });
      const group = await alice.createGroup("g", {
        keyPackageAlias: "kp",
        metadata: { name: "E0" },
      });
      const gid = alice.deriveGroupId(group.state);
      const baseEpoch = group.state.groupContext.epoch;

      // Device 2 seeds at the base epoch, then goes "offline" (no stream sync).
      const pub0 = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });
      const device2 = new CliSession({
        privateKey: alice.privateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(device2);
      const doc0 = await pullGroupDoc(
        device2,
        pub0.address,
        mediaStore,
        addressToUrl,
      );
      await reconcileGroupDocument(device2, doc0);
      const d2alias = device2.listGroups()[0]!.alias;
      expect(device2.getGroup(d2alias).state.groupContext.epoch).toBe(
        baseEpoch,
      );

      // Committer advances three epochs; device 2 sees none of it on the stream.
      for (const name of ["E1", "E2", "E3"]) {
        await alice.updateGroupMetadata("g", { name });
        await alice.syncGroup("g");
      }
      expect(alice.getGroup("g").state.groupContext.epoch).toBe(baseEpoch + 3n);

      // One reconcile jumps the whole gap.
      const pub3 = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });
      const doc3 = await pullGroupDoc(
        device2,
        pub3.address,
        mediaStore,
        addressToUrl,
      );
      expect(await reconcileGroupDocument(device2, doc3)).toBe(
        "fast-forwarded",
      );
      const d2 = device2.getGroup(d2alias);
      expect(d2.state.groupContext.epoch).toBe(baseEpoch + 3n);
      expect(getCordnGroupMetadataExtension(d2.state)?.name).toBe("E3");
      // Cursor advanced to the writer's progression, not stuck at the seed.
      expect(d2.fetchCursor).toBeGreaterThanOrEqual(doc3.cursor);

      // The adopted state is usable: the shared leaf still round-trips messages.
      await alice.sendMessage("g", "after-catchup");
      await device2.syncGroup(d2alias);
      expect(device2.listMessages(d2alias).map((m) => m.content)).toContain(
        "after-catchup",
      );
    } finally {
      await server.transport.close();
    }
  });

  /**
   * Content-address verification (spec §6 MUST). If the blob served by the
   * store does not hash to the advertised address (bit-rot, tampering, a
   * misaligned tip), pull MUST refuse the document rather than decrypt
   * untrusted bytes.
   */
  test("a blob whose hash does not match the advertised address is rejected", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const mediaStore = new FileMediaStore(
      await mkdtemp(join(tmpdir(), "cordn-md-t-")),
    );
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(alice);
      await alice.generateKeyPackage("kp", { localOnly: true });
      await alice.createGroup("g", {
        keyPackageAlias: "kp",
        metadata: { name: "G" },
      });
      const gid = alice.deriveGroupId(alice.getGroup("g").state);

      const pub = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });

      // Advertise a bogus address but serve the real blob: the store returns
      // the sealed document, whose sha256 does not match the bogus address.
      await expect(
        pullDocument({
          address: "0".repeat(64),
          mediaStore,
          addressToUrl: () => pub.url,
          privateKeyHex: alice.privateKey,
          ownerPubkey: alice.stablePubkey,
        }),
      ).rejects.toThrow(/address mismatch/i);
    } finally {
      await server.transport.close();
    }
  });

  /**
   * Scenario F — four devices, long-lived staggered convergence. One device
   * commits ~10 times while three others catch up purely through document
   * pulls (the read side) at different cadences: b frequently, c mid-stream and
   * at the end, dd only at the very end (full offline catch-up). Proves that
   * arbitrary catch-up timing converges every device to identical state.
   *
   * The three catching-up devices never touch the delivery stream here — they
   * reconcile documents only — so this isolates document-based convergence
   * (seed + fast-forward) from stream convergence (covered by A/D/E). Commits
   * are issued by a single device, so the symmetric sibling race (§10) cannot
   * arise. (Multi-device commits over the in-process relay collide on the
   * shared npub's request-response routing; that is a harness limit, not a
   * spec property — production uses one connection per device.)
   */
  test("four devices converge to identical state across ~10 commits with staggered catch-up", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const mediaStore = new FileMediaStore(
      await mkdtemp(join(tmpdir(), "cordn-md-f-")),
    );
    const addressToUrl = (address: string) => `media://${address}`;
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(alice);
      await alice.generateKeyPackage("kp", { localOnly: true });

      // Devices share alice's leaf; they only ever pull documents here.
      const mkDevice = () => {
        const d = new CliSession({
          privateKey: alice.privateKey,
          serverPubkey,
          relayHandler: relayHub.createRelayHandler(),
          mediaStore,
        });
        sessions.push(d);
        return d;
      };
      const pull = async (d: CliSession, address: string) => {
        const doc = await pullGroupDoc(d, address, mediaStore, addressToUrl);
        return reconcileGroupDocument(d, doc);
      };
      const epochOf = (d: CliSession, alias: string) =>
        d.getGroup(alias).state.groupContext.epoch;
      const metaName = (d: CliSession, alias: string) =>
        getCordnGroupMetadataExtension(d.getGroup(alias).state)?.name;
      const commit = async (name: string) => {
        await alice.updateGroupMetadata("g", { name });
        await alice.syncGroup("g");
      };

      const group = await alice.createGroup("g", {
        keyPackageAlias: "kp",
        metadata: { name: "c0" },
      });
      const gid = alice.deriveGroupId(group.state);
      const e0 = group.state.groupContext.epoch;
      const publish = () =>
        publishGroupDocument({ session: alice, mediaStore, gid });

      const b = mkDevice();
      const c = mkDevice();
      const dd = mkDevice();

      // b seeds early at epoch 0.
      let pub = await publish();
      await pull(b, pub.address);
      const bA = b.listGroups()[0]!.alias;

      // c1, c2 → epoch 2; b catches up (frequent cadence).
      await commit("c1");
      await commit("c2");
      pub = await publish();
      await pull(b, pub.address);
      expect(epochOf(b, bA)).toBe(e0 + 2n);

      // c3, c4 → epoch 4; b catches up.
      await commit("c3");
      await commit("c4");
      pub = await publish();
      await pull(b, pub.address);
      expect(epochOf(b, bA)).toBe(e0 + 4n);

      // c5, c6 → epoch 6; c seeds mid-stream, b catches up.
      await commit("c5");
      await commit("c6");
      pub = await publish();
      await pull(c, pub.address);
      const cA = c.listGroups()[0]!.alias;
      await pull(b, pub.address);
      expect(epochOf(c, cA)).toBe(e0 + 6n);

      // c7, c8 → epoch 8; b catches up. (c stays stale at 6 — catches up later.)
      await commit("c7");
      await commit("c8");
      pub = await publish();
      await pull(b, pub.address);
      expect(epochOf(b, bA)).toBe(e0 + 8n);

      // c9, c10 → epoch 10; publish. dd seeds ONLY now (full offline catch-up);
      // b and c reconcile to the tip — c jumps 6 → 10 in one pull.
      await commit("c9");
      await commit("c10");
      pub = await publish();
      await pull(dd, pub.address);
      const dA = dd.listGroups()[0]!.alias;
      await pull(c, pub.address);
      await pull(b, pub.address);

      // All four converged to epoch 10 / "c10".
      const want = e0 + 10n;
      const checks: Array<[CliSession, string]> = [
        [alice, "g"],
        [b, bA],
        [c, cA],
        [dd, dA],
      ];
      for (const [d, a] of checks) {
        expect(epochOf(d, a)).toBe(want);
        expect(metaName(d, a)).toBe("c10");
      }
    } finally {
      await server.transport.close();
    }
  });

  /**
   * Scenario G — chained catch-up (spec/applications/multi-device.md §8.5).
   *
   * A device offline across two sibling-commit epochs recovers the
   * application messages sent in BOTH epochs by walking the per-group `prev`
   * chain and decrypting each epoch's messages with that epoch's ClientState.
   * A single fast-forward to the tip would adopt a cursor past the first
   * epoch's messages and lose them; the chain is what makes offline catch-up
   * lossless up to the first epoch the chain cannot cover.
   */
  test("chained catch-up recovers messages across sibling-commit epochs (spec §8.5)", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const mediaStore = new FileMediaStore(
      await mkdtemp(join(tmpdir(), "cordn-md-chain-")),
    );
    const addressToUrl = (address: string) => `media://${address}`;
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(alice);
      await alice.generateKeyPackage("kp", { localOnly: true });
      await alice.createGroup("g", {
        keyPackageAlias: "kp",
        metadata: { name: "G" },
      });
      const gid = alice.deriveGroupId(alice.getGroup("g").state);

      // D0: epoch 0. `prev` auto-populates from here (spec §4.1).
      const pub0 = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });

      // bob seeds at epoch 0, then stays "offline" (no further sync) while
      // alice advances the group.
      const bob = new CliSession({
        privateKey: alice.privateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(bob);
      const doc0 = await pullGroupDoc(
        bob,
        pub0.address,
        mediaStore,
        addressToUrl,
      );
      await reconcileGroupDocument(bob, doc0);
      const bobAlias = bob.listGroups()[0]!.alias;
      const groupId = bob.deriveGroupId(bob.getGroup(bobAlias).state);
      expect(bob.getGroup(bobAlias).state.groupContext.epoch).toBe(0n);

      // alice advances two sibling-commit epochs, publishing after each commit
      // and sending one message into each epoch. Chain: D2 <- D1 <- D0.
      await alice.updateGroupMetadata("g", { name: "v1" });
      await alice.syncGroup("g");
      const pub1 = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });
      await alice.sendMessage("g", "m0"); // epoch 1

      await alice.updateGroupMetadata("g", { name: "v2" });
      await alice.syncGroup("g");
      const pub2 = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });
      await alice.sendMessage("g", "m1"); // epoch 2

      // Auto-chain: D2.prev == D1.address (spec §4.1 `prev` auto-populate).
      const doc2 = await pullGroupDoc(
        bob,
        pub2.address,
        mediaStore,
        addressToUrl,
      );
      expect(doc2.prev).toBe(pub1.address);

      // Walk the chain back from the tip: one gen-0 ClientState per epoch > 0.
      const chain = await walkGroupChain({
        tipAddress: pub2.address,
        groupId,
        localEpoch: 0n,
        mediaStore,
        addressToUrl,
        privateKeyHex: bob.privateKey,
        ownerPubkey: bob.stablePubkey,
      });
      expect(chain.map((step) => step.epoch)).toEqual([1n, 2n]);

      // Chained catch-up recovers BOTH messages. A single fast-forward to D2
      // would adopt a cursor past m0 and lose it.
      const { received } = await bob.catchUpGroupFromChain(bobAlias, chain);
      expect(received.map((m) => m.content)).toEqual(["m0", "m1"]);
      expect(bob.getGroup(bobAlias).state.groupContext.epoch).toBe(2n);
    } finally {
      await server.transport.close();
    }
  });

  // -------------------------------------------------------------------------
  // Tombstones (group removal sync), spec/applications/multi-device.md §8/§10.
  // No device-local tombstone memory: the meta document's `removed` array is
  // the authority, and §10.5 reconcile-before-push propagates deletions via the
  // published union. These tests pin that model.
  // -------------------------------------------------------------------------

  /**
   * Shared setup: one coordinator, alice creates a group and publishes, bob
   * (same identity) seeds it. Returns everything the tombstone tests need.
   */
  async function setupSeededPair() {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const mediaStore = new FileMediaStore(
      await mkdtemp(join(tmpdir(), "cordn-md-tomb-")),
    );
    const addressToUrl = (address: string) => `media://${address}`;
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });
    const alice = new CliSession({
      serverPubkey,
      relayHandler: relayHub.createRelayHandler(),
      mediaStore,
    });
    sessions.push(alice);
    await alice.generateKeyPackage("kp", { localOnly: true });
    const group = await alice.createGroup("g", {
      keyPackageAlias: "kp",
      metadata: { name: "G" },
    });
    const gid = alice.deriveGroupId(group.state);

    const bob = new CliSession({
      privateKey: alice.privateKey,
      serverPubkey,
      relayHandler: relayHub.createRelayHandler(),
      mediaStore,
    });
    sessions.push(bob);
    const pub0 = await publishGroupDocument({
      session: alice,
      mediaStore,
      gid,
    });
    const doc0 = await pullGroupDoc(
      bob,
      pub0.address,
      mediaStore,
      addressToUrl,
    );
    await reconcileGroupDocument(bob, doc0);
    const bobAlias = bob.listGroups()[0]!.alias;

    return {
      server,
      alice,
      bob,
      mediaStore,
      addressToUrl,
      gid,
      bobAlias,
      baseEpoch: group.state.groupContext.epoch,
    };
  }

  /** Case 4 (spec §8): a tombstone in the meta document drops the local group. */
  test("a tombstone drops the local group on reconcile (spec §8 case 4)", async () => {
    const ctx = await setupSeededPair();
    try {
      const tombstone = await ctx.alice.softDeleteGroup("g");
      expect(tombstone.gid).toBe(ctx.gid);

      // Soft-delete removes the group from the tip's live list and records the
      // tombstone in the meta document (spec §4.3 XOR invariant).
      const pub = await publishMetaDocument({
        session: ctx.alice,
        mediaStore: ctx.mediaStore,
        removed: [tombstone],
      });
      const doc = await pullMetaDoc(
        ctx.bob,
        pub.address,
        ctx.mediaStore,
        ctx.addressToUrl,
      );
      expect(doc.removed).toContainEqual(tombstone);

      const { dropped, ignored } = await reconcileMetaDocument(ctx.bob, doc);
      expect(dropped).toContainEqual(tombstone);
      expect(ignored).toHaveLength(0);
      expect(ctx.bob.listGroups()).toHaveLength(0);
    } finally {
      await ctx.server.transport.close();
    }
  });

  /** Case 5 (spec §8 anti-downgrade): a tombstone below the local epoch is ignored. */
  test("a stale tombstone (epoch below local) is ignored", async () => {
    const ctx = await setupSeededPair();
    try {
      // Advance bob's local group one epoch past the tombstone's epoch.
      await ctx.bob.updateGroupMetadata(ctx.bobAlias, { name: "advanced" });
      await ctx.bob.syncGroup(ctx.bobAlias);
      expect(ctx.bob.getGroup(ctx.bobAlias).state.groupContext.epoch).toBe(
        ctx.baseEpoch + 1n,
      );

      // A meta document carrying a stale tombstone at the base epoch.
      const staleDoc: MetaDocument = {
        schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
        type: "meta",
        issuedAt: Date.now(),
        removed: [{ gid: ctx.gid, epoch: Number(ctx.baseEpoch) }],
      };
      const { dropped, ignored } = await reconcileMetaDocument(
        ctx.bob,
        staleDoc,
      );
      expect(dropped).toHaveLength(0);
      expect(ignored).toContainEqual({
        gid: ctx.gid,
        epoch: Number(ctx.baseEpoch),
      });
      expect(ctx.bob.listGroups()).toHaveLength(1); // retained
    } finally {
      await ctx.server.transport.close();
    }
  });

  /** Absence from `removed` is not removal (spec §8). */
  test("a group absent from the meta document is not removed (absence != removal)", async () => {
    const ctx = await setupSeededPair();
    try {
      const absentDoc: MetaDocument = {
        schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
        type: "meta",
        issuedAt: Date.now(),
        removed: [],
      };
      const { dropped } = await reconcileMetaDocument(ctx.bob, absentDoc);
      expect(dropped).toHaveLength(0);
      expect(ctx.bob.listGroups()).toHaveLength(1); // G retained
      expect(ctx.bob.getGroup(ctx.bobAlias).state.groupContext.epoch).toBe(
        ctx.baseEpoch,
      );
    } finally {
      await ctx.server.transport.close();
    }
  });

  /**
   * Tombstones ride the union (spec §10.5): a device that adopted a peer's
   * tombstone re-publishes it, propagating the deletion — and does NOT
   * resurrect the group (it carries the tombstone, not a present entry).
   */
  test("an adopted tombstone rides the union and does not resurrect the group", async () => {
    const ctx = await setupSeededPair();
    try {
      const tombstone = await ctx.alice.softDeleteGroup("g");
      const pubA = await publishMetaDocument({
        session: ctx.alice,
        mediaStore: ctx.mediaStore,
        removed: [tombstone],
      });
      const docA = await pullMetaDoc(
        ctx.bob,
        pubA.address,
        ctx.mediaStore,
        ctx.addressToUrl,
      );
      const { dropped } = await reconcileMetaDocument(ctx.bob, docA);
      expect(dropped).toContainEqual(tombstone);
      expect(ctx.bob.listGroups()).toHaveLength(0);

      // bob re-publishes the union: the adopted tombstone (no group document —
      // bob holds no live group, so there is nothing to resurrect with).
      const pubB = await publishMetaDocument({
        session: ctx.bob,
        mediaStore: ctx.mediaStore,
        removed: docA.removed,
      });
      const docB = await pullMetaDoc(
        ctx.bob,
        pubB.address,
        ctx.mediaStore,
        ctx.addressToUrl,
      );
      expect(docB.removed).toContainEqual(tombstone);
    } finally {
      await ctx.server.transport.close();
    }
  });

  /**
   * Resurrection via a sibling Commit (spec §10). A tombstoned group is still
   * a live MLS membership; a sibling that advances it raises its epoch past
   * the tombstone, and the §8 rule resurrects the group on the device that
   * had dropped it. Single committer (bob) keeps the in-process relay off the
   * shared-npub concurrent-RPC collision.
   */
  test("a sibling commit at a higher epoch resurrects a tombstoned group (spec §10)", async () => {
    const ctx = await setupSeededPair();
    try {
      // alice soft-deletes G (drops it locally); bob has NOT reconciled the
      // tombstone and still has G — bob is the concurrent sibling.
      await ctx.alice.softDeleteGroup("g");
      expect(ctx.alice.listGroups()).toHaveLength(0);

      // bob advances G by one epoch and publishes a group document (no
      // tombstone — bob never saw alice's deletion).
      await ctx.bob.updateGroupMetadata(ctx.bobAlias, { name: "resurrected" });
      await ctx.bob.syncGroup(ctx.bobAlias);
      expect(ctx.bob.getGroup(ctx.bobAlias).state.groupContext.epoch).toBe(
        ctx.baseEpoch + 1n,
      );

      const pubB = await publishGroupDocument({
        session: ctx.bob,
        mediaStore: ctx.mediaStore,
        gid: ctx.gid,
      });
      const docB = await pullGroupDoc(
        ctx.alice,
        pubB.address,
        ctx.mediaStore,
        ctx.addressToUrl,
      );
      expect(docB.gid).toBe(ctx.gid);

      // alice pulls bob's doc: present@(base+1) vs unknown (alice dropped G)
      // → seed. The group is resurrected at the higher epoch.
      expect(await reconcileGroupDocument(ctx.alice, docB)).toBe("seeded");
      expect(ctx.alice.listGroups()).toHaveLength(1);
      const aliceAlias = ctx.alice.listGroups()[0]!.alias;
      expect(ctx.alice.getGroup(aliceAlias).state.groupContext.epoch).toBe(
        ctx.baseEpoch + 1n,
      );
    } finally {
      await ctx.server.transport.close();
    }
  });

  /**
   * softDeleteGroup (spec §10): drops the local group, returns the tombstone,
   * and fires the re-publish hook so siblings converge.
   */
  test("softDeleteGroup drops the group, returns the tombstone, and fires onLocalStateAdvance", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const fired: string[] = [];
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });
    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        onLocalStateAdvance: () => {
          fired.push("advance");
        },
      });
      sessions.push(alice);
      await alice.generateKeyPackage("kp", { localOnly: true });
      const group = await alice.createGroup("g", {
        keyPackageAlias: "kp",
        metadata: { name: "G" },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fired).toEqual(["advance"]); // createGroup

      const gid = alice.deriveGroupId(group.state);
      const tombstone = await alice.softDeleteGroup("g");
      expect(tombstone).toEqual({
        gid,
        epoch: Number(group.state.groupContext.epoch),
      });
      expect(alice.listGroups()).toHaveLength(0);

      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fired).toEqual(["advance", "advance"]); // softDelete fired the hook
    } finally {
      await server.transport.close();
    }
  });

  /**
   * The meta document replicates the account's last-resort key package (spec
   * §4.2/§11.5). alice generates a last-resort key package and publishes a
   * meta document; bob (same identity, no key package) loads it from the meta
   * document and can then resolve a Welcome built against it. The TLS
   * round-trip (encode → seal → decrypt → decode) preserves the package.
   */
  test("the meta document replicates the last-resort key package (spec §11.5)", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const mediaStore = new FileMediaStore(
      await mkdtemp(join(tmpdir(), "cordn-md-kp-")),
    );
    const addressToUrl = (address: string) => `media://${address}`;
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(alice);
      const aliceKp = await alice.generateKeyPackage("lr", {
        lastResort: true,
        localOnly: true,
      });
      expect(aliceKp.isLastResort).toBe(true);

      // alice publishes a meta document carrying its last-resort key package.
      const pub = await publishMetaDocument({
        session: alice,
        mediaStore,
      });
      expect(pub.address).toHaveLength(64);

      // bob (same identity) holds no key package yet.
      const bob = new CliSession({
        privateKey: alice.privateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(bob);
      expect(bob.listKeyPackages()).toHaveLength(0);

      const doc = await pullMetaDoc(bob, pub.address, mediaStore, addressToUrl);
      expect(doc.lastResortKeyPackage?.keyPackage).toBe(
        aliceKp.keyPackageBase64,
      );

      const { keyPackageLoaded } = await reconcileMetaDocument(bob, doc);
      expect(keyPackageLoaded).toBe(true);

      // bob now holds the replicated last-resort key package, and re-exposing
      // it (idempotency) does not duplicate.
      const bobKps = bob.listKeyPackages();
      expect(bobKps).toHaveLength(1);
      expect(bobKps[0]!.isLastResort).toBe(true);
      expect(bobKps[0]!.keyPackageBase64).toBe(aliceKp.keyPackageBase64);

      const second = await reconcileMetaDocument(bob, doc);
      expect(second.keyPackageLoaded).toBe(false); // already held
      expect(bob.listKeyPackages()).toHaveLength(1);
    } finally {
      await server.transport.close();
    }
  });

  /**
   * End-to-end (spec §6/§11): a device publishes a group document, points the
   * hardened tip at it (one typed `x` tag per live group + the meta doc), and
   * mints a connection string. A second device of the same identity bootstraps
   * from the string ALONE — reads the tip, fetches + verifies the document,
   * seeds the shared leaf — then converges with the first device over the
   * normal delivery stream. Ties the document layer (§4–§9) to the tip
   * transport (§6) and the bootstrap flow (§11).
   */
  test("a device bootstraps from a connection string and converges (spec §6/§11)", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const mediaStore = new FileMediaStore(
      await mkdtemp(join(tmpdir(), "cordn-md-e2e-")),
    );
    // FileMediaStore url is `media://<sha256>` — treat `media://` as the toy
    // Blossom server base (production uses https server URLs per §6/§12).
    const mediaServer = "media://";
    const urlFromTip = (address: string, servers: string[]) =>
      `${servers[0]}${address}`;
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });
    try {
      const alice = new CliSession({
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(alice);
      await alice.generateKeyPackage("kp", { localOnly: true });
      const group = await alice.createGroup("g", {
        keyPackageAlias: "kp",
        metadata: { name: "G" },
      });
      const gid = alice.deriveGroupId(group.state);

      // alice publishes its group document and points the tip at it (one
      // group `x` tag), then mints the connection string.
      const aliceTip = new NostrTipStore({
        relayHandler: relayHub.createRelayHandler(),
        ownerPrivateKey: Buffer.from(alice.privateKey, "hex"),
        ownerPubkey: alice.stablePubkey,
      });
      const pub = await publishGroupDocument({
        session: alice,
        mediaStore,
        gid,
      });
      await aliceTip.publishTip({
        groups: [{ address: pub.address, gid }],
        servers: [mediaServer],
      });
      const conn = aliceTip.toConnectionString(["memory://relay"]);

      // bob bootstraps from the connection string alone (same identity).
      const bob = new CliSession({
        privateKey: alice.privateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(bob);
      const bobTip = NostrTipStore.fromConnectionString(conn, {
        relayHandler: relayHub.createRelayHandler(),
        ownerPrivateKey: Buffer.from(bob.privateKey, "hex"),
        ownerPubkey: bob.stablePubkey,
      });
      const pointer = await bobTip.readTip();
      expect(pointer).not.toBeNull();
      expect(pointer!.groups).toHaveLength(1);
      expect(pointer!.groups[0]!.address).toBe(pub.address);
      expect(pointer!.groups[0]!.gid).toBe(gid);

      const groupAddress = pointer!.groups[0]!.address;
      const doc = await pullGroupDoc(bob, groupAddress, mediaStore, (address) =>
        urlFromTip(address, pointer!.servers),
      );
      expect(await reconcileGroupDocument(bob, doc)).toBe("seeded");
      const bobAlias = bob.listGroups()[0]!.alias;
      expect(bob.deriveGroupId(bob.getGroup(bobAlias).state)).toBe(gid);

      // Convergence over the normal delivery stream.
      await alice.sendMessage("g", "hello from alice");
      await bob.syncGroup(bobAlias);
      expect(bob.listMessages(bobAlias).map((m) => m.content)).toContain(
        "hello from alice",
      );
    } finally {
      await server.transport.close();
    }
  });
});
