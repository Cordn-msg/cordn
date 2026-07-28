import { afterAll, afterEach, describe, expect, test } from "vitest";
import { bytesToHex } from "nostr-tools/utils";

import { connectServer } from "@cordn/server";
import { MockRelayHub } from "@cordn/test-utils";
import { createActor, createMemberArtifacts } from "@cordn/test-utils";
import { PrivateKeySigner, type RelayHandler } from "@contextvm/sdk";
import { encodeBase64, encodeKeyPackage } from "@cordn/core";

import { ContextVmTransport } from "./contextVmTransport.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function stubEvent(pubkey: string) {
  return {
    id: "0".repeat(64),
    pubkey,
    created_at: 1,
    kind: 1,
    tags: [],
    content: "",
    sig: "0".repeat(128),
  };
}

describe("ContextVmTransport integration — over a real @contextvm/sdk relay", () => {
  const transports: ContextVmTransport[] = [];
  const serverClosers: Array<() => void> = [];

  afterEach(async () => {
    await Promise.allSettled(transports.splice(0).map((t) => t.disconnect()));
    serverClosers.splice(0).forEach((close) => close());
  });

  afterAll(async () => {
    await Promise.allSettled(transports.splice(0).map((t) => t.disconnect()));
    serverClosers.splice(0).forEach((close) => close());
  });

  async function makeTransport(
    actor: { secretKey: Uint8Array },
    serverPubkey: string,
    relayHandler: RelayHandler,
  ) {
    const transport = new ContextVmTransport({
      serverPubkey,
      relayHandler,
      authedSigner: bytesToHex(actor.secretKey),
    });
    transports.push(transport);
    return transport;
  }

  test("publish → consume reconstructs the key package through the full wire stack", async () => {
    const relayHub = new MockRelayHub();
    const relayHandler = relayHub.createRelayHandler();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();

    const server = await connectServer({ signer: serverSigner, relayHandler });
    serverClosers.push(() => server.close());

    const actor = createActor("alice");
    const artifacts = await createMemberArtifacts(actor);

    const transport = await makeTransport(actor, serverPubkey, relayHandler);

    const kp64 = encodeBase64(encodeKeyPackage(artifacts.keyPackage));
    await transport.publishKeyPackage({
      stablePubkey: actor.stablePubkey,
      keyPackage: artifacts.keyPackage,
      keyPackageRef: "alice-1",
      publicationEvent: stubEvent(actor.stablePubkey),
    });

    const consumed = await transport.consumeKeyPackage("alice-1");
    expect(consumed).not.toBeNull();
    expect(consumed!.stablePubkey).toBe(actor.stablePubkey);
    expect(consumed!.keyPackageRef).toBe("alice-1");
    expect(encodeBase64(encodeKeyPackage(consumed!.keyPackage))).toBe(kp64);
  });

  test("postGroupMessage → fetchGroupMessages round-trips through the wire", async () => {
    const relayHub = new MockRelayHub();
    const relayHandler = relayHub.createRelayHandler();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({ signer: serverSigner, relayHandler });
    serverClosers.push(() => server.close());

    const actor = createActor("bob");
    const transport = await makeTransport(actor, serverPubkey, relayHandler);

    const groupId = "group-wire";
    const posted = await transport.postGroupMessage({
      groupId,
      opaqueMessage: enc("hello-wire"),
    });
    expect(posted.groupId).toBe(groupId);

    const fetched = await transport.fetchGroupMessages({ groupId });
    expect(fetched).toHaveLength(1);
    expect(new TextDecoder().decode(fetched[0]!.opaqueMessage)).toBe(
      "hello-wire",
    );
  });
});
