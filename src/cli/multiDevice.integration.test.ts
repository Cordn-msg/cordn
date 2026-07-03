import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { CliSession } from "./session.ts";
import { FileMediaStore } from "./mediaStore.ts";
import { connectServer } from "../server/coordinatorServer.ts";
import { MockRelayHub } from "../test/mockRelay.ts";
import { PrivateKeySigner } from "@contextvm/sdk";
import {
  InMemoryTipStore,
  MULTI_DEVICE_SCHEMA_VERSION,
  publishCurrentSession,
  pullSessionDocument,
  reconcileFromDocument,
  signDocument,
  verifyDocumentSignature,
  type SessionDocument,
} from "./multiDevice.ts";
import { clientStateEncoder, encode } from "ts-mls";
import { getCordnGroupMetadataExtension } from "./groupMetadata.ts";
import { deriveStablePubkey } from "./utils/mlsBase.ts";

/**
 * Multi-device synchronization scenarios (spec/applications/multi-device.md).
 *
 * One in-process coordinator (MockRelayHub + connectServer), a shared
 * FileMediaStore as the Blossom stand-in, and an InMemoryTipStore for the
 * mutable tip. Two CliSessions sharing one `privateKey` emulate two devices of
 * one identity on a single shared MLS leaf.
 *
 * Convergence model validated here:
 *  - Application messages between siblings converge via the delivery stream.
 *  - A sibling device's Commit CANNOT be ingested via the stream (the shared
 *    leaf's UpdatePath invalidates the receiving device's keys). The committing
 *    device re-publishes; the sibling fast-forwards its ClientState to the
 *    newer epoch from the document.
 */
describe("multi-device synchronization", () => {
  const sessions: CliSession[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      sessions.splice(0).map((session) => session.disconnect()),
    );
  });

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
    const tipStore = new InMemoryTipStore();
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

      // Publish BEFORE sending so the seed state precedes the messages.
      const pub = await publishCurrentSession({
        session: alice,
        mediaStore,
      });
      expect(pub.address).toHaveLength(64);
      await tipStore.set(alice.stablePubkey, pub.address);

      const device2 = new CliSession({
        privateKey: alice.privateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(device2);
      expect(device2.stablePubkey).toBe(alice.stablePubkey);
      expect(device2.listGroups()).toHaveLength(0);

      const doc = await pullSessionDocument({
        address: pub.address,
        mediaStore,
        addressToUrl,
        privateKeyHex: device2.privateKey,
        ownerPubkey: device2.stablePubkey,
      });
      const { seeded, fastForwarded, skipped } = await reconcileFromDocument(
        device2,
        doc,
      );
      expect(seeded).toHaveLength(1);
      expect(fastForwarded).toHaveLength(0);
      expect(skipped).toHaveLength(0);
      const d2alias = device2.listGroups()[0]!.alias;

      // Same shared leaf (delivery group id).
      expect(device2.deriveGroupId(device2.getGroup(d2alias).state)).toBe(
        alice.deriveGroupId(alice.getGroup("demo").state),
      );

      // Now alice sends; device 2 receives purely via the stream.
      await alice.sendMessage("demo", "hello");
      await alice.sendMessage("demo", "world");
      const received = await device2.syncGroup(d2alias);
      expect(received.map((m) => m.content)).toEqual(["hello", "world"]);

      // Replaying the same document must not re-seed or overwrite (spec §8).
      const replay = await reconcileFromDocument(device2, doc);
      expect(replay.seeded).toHaveLength(0);
      expect(replay.fastForwarded).toHaveLength(0);
      expect(replay.skipped).toHaveLength(1);

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
    const tipStore = new InMemoryTipStore();
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
      const baseEpoch = group.state.groupContext.epoch;

      const pub0 = await publishCurrentSession({ session: alice, mediaStore });
      await tipStore.set(alice.stablePubkey, pub0.address);
      const device2 = new CliSession({
        privateKey: alice.privateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(device2);
      const doc0 = await pullSessionDocument({
        address: pub0.address,
        mediaStore,
        addressToUrl,
        privateKeyHex: device2.privateKey,
        ownerPubkey: device2.stablePubkey,
      });
      await reconcileFromDocument(device2, doc0);
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
      const pub1 = await publishCurrentSession({ session: alice, mediaStore });
      await tipStore.set(alice.stablePubkey, pub1.address);

      // Device 2 fast-forwards from the new document (no stream sync).
      const doc1 = await pullSessionDocument({
        address: pub1.address,
        mediaStore,
        addressToUrl,
        privateKeyHex: device2.privateKey,
        ownerPubkey: device2.stablePubkey,
      });
      const { fastForwarded, skipped } = await reconcileFromDocument(
        device2,
        doc1,
      );
      expect(fastForwarded).toHaveLength(1);
      expect(skipped).toHaveLength(0);

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
      const stale = await reconcileFromDocument(device2, doc0);
      expect(stale.fastForwarded).toHaveLength(0);
      expect(stale.skipped).toHaveLength(1);

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
      const baseEpoch = group.state.groupContext.epoch;

      // Seed device 2 at the base epoch.
      const pub0 = await publishCurrentSession({ session: alice, mediaStore });
      const device2 = new CliSession({
        privateKey: alice.privateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(device2);
      const doc0 = await pullSessionDocument({
        address: pub0.address,
        mediaStore,
        addressToUrl,
        privateKeyHex: device2.privateKey,
        ownerPubkey: device2.stablePubkey,
      });
      await reconcileFromDocument(device2, doc0);
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
      const pub1 = await publishCurrentSession({ session: alice, mediaStore });
      const doc1 = await pullSessionDocument({
        address: pub1.address,
        mediaStore,
        addressToUrl,
        privateKeyHex: device2.privateKey,
        ownerPubkey: device2.stablePubkey,
      });
      const { fastForwarded } = await reconcileFromDocument(device2, doc1);
      expect(fastForwarded).toHaveLength(1);
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
   * epochs. Pulling the latest document MUST fast-forward across the whole gap
   * in one reconcile (not +1 at a time), land on the correct state and cursor,
   * and leave the shared leaf usable for messages. Existing scenarios only jump
   * a single epoch; this proves the catch-up path scales to a real gap.
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
      const baseEpoch = group.state.groupContext.epoch;

      // Device 2 seeds at the base epoch, then goes "offline" (no stream sync).
      const pub0 = await publishCurrentSession({ session: alice, mediaStore });
      const device2 = new CliSession({
        privateKey: alice.privateKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        mediaStore,
      });
      sessions.push(device2);
      const doc0 = await pullSessionDocument({
        address: pub0.address,
        mediaStore,
        addressToUrl,
        privateKeyHex: device2.privateKey,
        ownerPubkey: device2.stablePubkey,
      });
      await reconcileFromDocument(device2, doc0);
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
      const pub3 = await publishCurrentSession({ session: alice, mediaStore });
      const doc3 = await pullSessionDocument({
        address: pub3.address,
        mediaStore,
        addressToUrl,
        privateKeyHex: device2.privateKey,
        ownerPubkey: device2.stablePubkey,
      });
      const { fastForwarded } = await reconcileFromDocument(device2, doc3);
      expect(fastForwarded).toHaveLength(1);
      const d2 = device2.getGroup(d2alias);
      expect(d2.state.groupContext.epoch).toBe(baseEpoch + 3n);
      expect(getCordnGroupMetadataExtension(d2.state)?.name).toBe("E3");
      // Cursor advanced to the writer's progression, not stuck at the seed.
      expect(d2.fetchCursor).toBeGreaterThanOrEqual(doc3.groups[0]!.cursor);

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

      const pub = await publishCurrentSession({ session: alice, mediaStore });

      // Advertise a bogus address but serve the real blob: the store returns
      // the sealed document, whose sha256 does not match the bogus address.
      await expect(
        pullSessionDocument({
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

  test("signature verification rejects tampered, rekeyed, and unsigned documents", () => {
    const privateKey = Buffer.from(randomBytes(32)).toString("hex");
    const ownerPubkey = deriveStablePubkey(privateKey);

    const doc: SessionDocument = {
      schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
      issuedAt: 123,
      groups: [],
    };
    const signed = signDocument(doc, privateKey);
    // 64-byte BIP340 signature, hex-encoded.
    expect(signed.signature).toHaveLength(128);
    expect(() => verifyDocumentSignature(signed, ownerPubkey)).not.toThrow();

    // Tampering any covered field invalidates the signature.
    expect(() =>
      verifyDocumentSignature({ ...signed, issuedAt: 999 }, ownerPubkey),
    ).toThrow(/does not verify/i);

    // A different verifying key rejects it — only the owner nsec could sign.
    expect(() =>
      verifyDocumentSignature(
        signed,
        deriveStablePubkey(Buffer.from(randomBytes(32)).toString("hex")),
      ),
    ).toThrow(/does not verify/i);

    // A document with no signature is rejected.
    const unsigned: SessionDocument = { ...signed };
    delete unsigned.signature;
    expect(() => verifyDocumentSignature(unsigned, ownerPubkey)).toThrow(
      /no owner signature/i,
    );
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
      const pull = async (d: CliSession, address: string) =>
        reconcileFromDocument(
          d,
          await pullSessionDocument({
            address,
            mediaStore,
            addressToUrl,
            privateKeyHex: d.privateKey,
            ownerPubkey: d.stablePubkey,
          }),
        );
      const epochOf = (d: CliSession, alias: string) =>
        d.getGroup(alias).state.groupContext.epoch;
      const metaName = (d: CliSession, alias: string) =>
        getCordnGroupMetadataExtension(d.getGroup(alias).state)?.name;
      const commit = async (name: string) => {
        await alice.updateGroupMetadata("g", { name });
        await alice.syncGroup("g");
      };
      const publish = () =>
        publishCurrentSession({ session: alice, mediaStore });

      const group = await alice.createGroup("g", {
        keyPackageAlias: "kp",
        metadata: { name: "c0" },
      });
      const e0 = group.state.groupContext.epoch;
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
});
