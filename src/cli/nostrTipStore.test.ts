import { describe, expect, test } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type EventTemplate,
} from "nostr-tools/pure";
import { nip44 } from "nostr-tools";

import { MockRelayHub } from "../test/mockRelay.ts";
import { NostrTipStore } from "./nostrTipStore.ts";

/**
 * Hardened tip transport (spec/applications/multi-device.md §6, §11). The
 * MockRelayHub stands in for the Nostr relay network; its `getEvents()` lets
 * the tests inspect exactly what was relayed — which is what makes the privacy
 * property (owner npub never appears in the clear) directly assertable.
 */
describe("NostrTipStore (hardened tip transport)", () => {
  const ADDRESS = "a".repeat(64);
  const META_ADDRESS = "b".repeat(64);
  const GID = "g".repeat(16);
  const SERVERS = ["https://blossom.example.tld", "https://cdn.other.tld"];

  /** A fresh owner keypair + a store on a new relay hub. */
  function setup(opts: { ephemeralPrivateKey?: Uint8Array; d?: string } = {}) {
    const relayHub = new MockRelayHub();
    const ownerPrivateKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerPrivateKey);
    const store = new NostrTipStore({
      relayHandler: relayHub.createRelayHandler(),
      ownerPrivateKey,
      ownerPubkey,
      ephemeralPrivateKey: opts.ephemeralPrivateKey,
      d: opts.d,
    });
    return { relayHub, ownerPrivateKey, ownerPubkey, store };
  }

  test("publish then read round-trips group and meta pointers", async () => {
    const { store } = setup();
    await store.publishTip({
      groups: [{ address: ADDRESS, gid: GID }],
      metaAddress: META_ADDRESS,
      servers: SERVERS,
    });
    expect(await store.readTip()).toEqual({
      groups: [{ address: ADDRESS, gid: GID }],
      metaAddress: META_ADDRESS,
      servers: SERVERS,
    });
  });

  test("readTip returns null before any publish", async () => {
    const { store } = setup();
    expect(await store.readTip()).toBeNull();
  });

  /**
   * The load-bearing privacy property (spec §6): the owner npub never appears
   * in the clear on the relay. Only the ephemeral pubkey is relayed; the owner
   * npub lives only inside the NIP-44 seal. The typed `x` tags (document
   * inventory) live INSIDE that seal, never in the public outer event.
   */
  test("the owner npub never appears in any relayed event", async () => {
    const { relayHub, ownerPubkey, store } = setup();
    await store.publishTip({
      groups: [{ address: ADDRESS, gid: GID }],
      metaAddress: META_ADDRESS,
      servers: SERVERS,
    });

    const events = relayHub.getEvents();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.pubkey).toBe(store.ephemeralPubkey);
    expect(event.pubkey).not.toBe(ownerPubkey);
    // Owner npub nowhere in the public event surface (it is sealed in content).
    expect(JSON.stringify(event)).not.toContain(ownerPubkey);
    // The only public tag is the opaque `d`; no `x`, no `server`, no owner link.
    expect(event.tags).toEqual([["d", store.d]]);
  });

  /**
   * Replaceable semantics (spec §6): the `d` tag is stable across republishes,
   * created_at strictly advances, and readTip serves the greatest created_at.
   */
  test("republish supersedes: stable d, advancing created_at, latest wins", async () => {
    const { relayHub, store } = setup();
    await store.publishTip({
      groups: [{ address: "1".repeat(64), gid: GID }],
      servers: ["https://a"],
    });
    await store.publishTip({
      groups: [{ address: "2".repeat(64), gid: GID }],
      servers: ["https://b"],
    });

    const events = relayHub.getEvents();
    expect(events).toHaveLength(2);
    // d stable across both publishes.
    const dTags = events.map((e) => e.tags.find((t) => t[0] === "d")?.[1]);
    expect(dTags.every((d) => d === store.d)).toBe(true);
    // created_at strictly increasing → the later publish supersedes.
    expect(events[1]!.created_at).toBeGreaterThan(events[0]!.created_at);

    expect(await store.readTip()).toEqual({
      groups: [{ address: "2".repeat(64), gid: GID }],
      metaAddress: undefined,
      servers: ["https://b"],
    });
  });

  /**
   * Authenticity (spec §6): readTip verifies the inner event's owner signature.
   * A sealed inner event whose signature does not verify is rejected. This is
   * the property that bounds a leaked ephemeral key to denial-of-service
   * (repointing to a stale-but-valid older inner) rather than forgery.
   */
  test("readTip rejects an inner event whose owner signature does not verify", async () => {
    const ephemeralKey = generateSecretKey();
    const d = "d".repeat(8);
    const { relayHub, ownerPrivateKey, ownerPubkey, store } = setup({
      ephemeralPrivateKey: ephemeralKey,
      d,
    });

    // Forge a well-formed-looking inner signed by NO ONE (bogus id/sig), seal
    // it to the real owner, and wrap it in a valid outer signed by the real
    // ephemeral key — so the relay filter matches but the inner is unverified.
    const forged = {
      kind: 178,
      pubkey: ownerPubkey,
      content: "",
      created_at: 1,
      tags: [
        ["x", "f".repeat(64), "group", GID],
        ["server", "https://forged"],
      ],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };
    const seal = nip44.encrypt(
      JSON.stringify(forged),
      nip44.getConversationKey(ownerPrivateKey, ownerPubkey),
    );
    const outer: EventTemplate = {
      kind: 30078,
      content: seal,
      created_at: 2,
      tags: [["d", d]],
    };
    await relayHub
      .createRelayHandler()
      .publish(finalizeEvent(outer, ephemeralKey));

    await expect(store.readTip()).rejects.toThrow(/signature/i);
  });

  /**
   * Connection string (spec §11): an existing device mints it; a new device
   * (same owner nsec, its own relay connection) bootstraps a store from it and
   * reads the tip. Round-trips the ephemeral locator + write key.
   */
  test("a connection string bootstraps a reader that reads the tip", async () => {
    const { relayHub, ownerPrivateKey, ownerPubkey, store } = setup();
    await store.publishTip({
      groups: [{ address: ADDRESS, gid: GID }],
      servers: SERVERS,
    });

    const conn = store.toConnectionString(["memory://relay"]);

    // A second device on the same relay network, same owner identity.
    const reader = NostrTipStore.fromConnectionString(conn, {
      relayHandler: relayHub.createRelayHandler(),
      ownerPrivateKey,
      ownerPubkey,
    });
    expect(reader.ephemeralPubkey).toBe(store.ephemeralPubkey);
    expect(reader.d).toBe(store.d);
    expect(await reader.readTip()).toEqual({
      groups: [{ address: ADDRESS, gid: GID }],
      metaAddress: undefined,
      servers: SERVERS,
    });
  });

  /**
   * Rotation (spec §11): minting a fresh ephemeral keypair AND fresh `d` starts
   * an independent replaceable stream. The old locator stops advancing; the new
   * one carries the tip forward. (Rotating only the key leaves stale events
   * under the old (pubkey, d) that readers must filter — hence rotate both.)
   */
  test("rotation mints a fresh ephemeral key and d, leaving the old tip stale", async () => {
    const { relayHub, ownerPrivateKey, ownerPubkey, store } = setup();
    await store.publishTip({
      groups: [{ address: ADDRESS, gid: GID }],
      servers: SERVERS,
    });

    // A brand-new store (fresh ephemeral + d) publishes a newer pointer.
    const rotated = new NostrTipStore({
      relayHandler: relayHub.createRelayHandler(),
      ownerPrivateKey,
      ownerPubkey,
    });
    expect(rotated.ephemeralPubkey).not.toBe(store.ephemeralPubkey);
    expect(rotated.d).not.toBe(store.d);
    await rotated.publishTip({
      groups: [{ address: "f".repeat(64), gid: GID }],
      servers: ["https://rotated"],
    });

    // The old locator still resolves to the old tip (it is not deleted, just
    // abandoned); the rotated locator resolves to the new one.
    expect(await store.readTip()).toEqual({
      groups: [{ address: ADDRESS, gid: GID }],
      metaAddress: undefined,
      servers: SERVERS,
    });
    expect(await rotated.readTip()).toEqual({
      groups: [{ address: "f".repeat(64), gid: GID }],
      metaAddress: undefined,
      servers: ["https://rotated"],
    });
  });
});
