import { afterEach, describe, expect, test } from "vitest";
import type { Filter, NostrEvent } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { generateSecretKey } from "nostr-tools/pure";
import { PrivateKeySigner, type RelayHandler } from "@contextvm/sdk";

import { connectServer } from "@cordn/server";
import { MockRelayHub } from "@cordn/test-utils";
import { encodeBase64 } from "@cordn/core";
import { cordnClient, type TransportEncryption } from "./coordinatorClient.ts";
import { CliSession } from "./session.ts";

const PLAINTEXT_KIND = 25910;
const EPHEMERAL_GIFT_WRAP_KIND = 21059;

/**
 * What a coordinator subscribed to several relays sees: every event once per
 * relay. The relay pool forwards all copies by design and leaves dedupe to
 * the transport.
 */
function fanOut(inner: RelayHandler, copies: number): RelayHandler {
  return {
    connect: () => inner.connect(),
    disconnect: (relayUrls?: string[]) => inner.disconnect(relayUrls),
    publish: (event: NostrEvent) => inner.publish(event),
    subscribe: (
      filters: Filter[],
      onEvent: (event: NostrEvent) => void,
      onEose?: () => void,
    ) =>
      inner.subscribe(
        filters,
        (event) => {
          for (let i = 0; i < copies; i += 1) onEvent(event);
        },
        onEose,
      ),
    unsubscribe: () => inner.unsubscribe(),
    getRelayUrls: () => inner.getRelayUrls(),
  } as RelayHandler;
}

describe("coordinator transport encryption", () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function setup(transportEncryption?: TransportEncryption) {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: fanOut(relayHub.createRelayHandler(), 2),
    });
    cleanups.push(() => server.transport.close());
    const client = new cordnClient({
      privateKey: bytesToHex(generateSecretKey()),
      serverPubkey,
      relayHandler: relayHub.createRelayHandler(),
      transportEncryption,
    });
    cleanups.push(() => client.disconnect());
    return { relayHub, serverPubkey, client };
  }

  const clientKinds = (relayHub: MockRelayHub, serverPubkey: string) =>
    new Set(
      relayHub
        .getEvents()
        .filter((event) => event.pubkey !== serverPubkey)
        .map((event) => event.kind),
    );

  test("by default a request relayed twice is stored twice", async () => {
    const { relayHub, serverPubkey, client } = await setup();
    const posted = await client.PostGroupMessage({
      gid: "g",
      msg_64: encodeBase64(new Uint8Array([1, 2, 3])),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stored = await client.FetchManyGroupMessages({
      groups: [{ gid: posted.gid }],
    });

    expect(clientKinds(relayHub, serverPubkey)).toEqual(
      new Set([PLAINTEXT_KIND]),
    );
    expect(stored.messages).toHaveLength(2);
  });

  test("with transport encryption required, requests are gift-wrapped and stored once", async () => {
    const { relayHub, serverPubkey, client } = await setup("required");
    const posted = await client.PostGroupMessage({
      gid: "g",
      msg_64: encodeBase64(new Uint8Array([1, 2, 3])),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stored = await client.FetchManyGroupMessages({
      groups: [{ gid: posted.gid }],
    });

    expect(clientKinds(relayHub, serverPubkey)).toEqual(
      new Set([EPHEMERAL_GIFT_WRAP_KIND]),
    );
    expect(stored.messages).toHaveLength(1);
    expect(stored.messages[0]?.cursor).toBe(posted.cursor);
  });

  test("CliSession passes transportEncryption to its coordinator clients", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });
    cleanups.push(() => server.transport.close());
    const session = new CliSession({
      serverPubkey,
      relayHandler: relayHub.createRelayHandler(),
      transportEncryption: "required",
    });
    cleanups.push(() => session.disconnect());

    await session.generateKeyPackage("kp", { lastResort: true });
    expect(await session.fetchWelcomes()).toEqual([]);

    expect(clientKinds(relayHub, serverPubkey)).toEqual(
      new Set([EPHEMERAL_GIFT_WRAP_KIND]),
    );
  });
});
