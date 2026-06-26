import { afterEach, describe, expect, test } from "vitest";
import {
  EncryptionMode,
  PrivateKeySigner,
  type RelayHandler,
} from "@contextvm/sdk";
import { bytesToHex } from "nostr-tools/utils";

import { connectServer } from "../server/coordinatorServer.ts";
import { MockRelayHub } from "../test/mockRelay.ts";
import {
  createApplicationMessageBytes,
  createThreeActorGroupScenario,
} from "../coordinator/testUtils.ts";
import { decodeBase64, encodeBase64 } from "../server/base64.ts";
import { cordnClient } from "./coordinatorClient.ts";

/**
 * CEP-22 oversized-transfer coverage for bounded catch-up.
 *
 * The ContextVM SDK switches a response to chunked `notifications/progress`
 * transfer once the final published Nostr event exceeds
 * `DEFAULT_OVERSIZED_THRESHOLD` (~48KB). The CLI client wires
 * `onprogress` + `resetTimeoutOnProgress` onto every `tools/call` request (see
 * `coordinatorClient.ts` `call()`) so the request carries the progress token
 * the SDK needs to engage that path.
 *
 * These tests cover the catch-up edge case the README documents: a client that
 * performs a bounded fetch (`FetchGroupMessages` / `FetchManyGroupMessages`)
 * whose payload is larger than the ~48KB limit.
 *
 * Reproduction summary (see the gift-wrap test below):
 * - With encryption DISABLED, an aggregated oversized catch-up response is
 *   chunked and reassembled correctly.
 * - With gift-wrap encryption ENABLED, the same aggregated oversized catch-up
 *   response never reaches the client: the server emits only the gift-wrapped
 *   start frame and no chunk frames, so the request times out. This reproduces
 *   the failure observed in the web client.
 */

/** Per-message plaintext size. Five of these aggregate to a response whose
 *  serialized form comfortably exceeds the ~48KB oversized threshold, while each
 *  individual `PostGroupMessage` request stays well under both the oversized
 *  threshold and the NIP-44 65535-byte gift-wrap plaintext limit. */
const PER_MESSAGE_PLAINTEXT_BYTES = 20_000;
const CATCH_UP_MESSAGE_COUNT = 5;

async function createClient(params: {
  privateKey: Uint8Array;
  serverPubkey: string;
  relayHandler: RelayHandler;
  encryptionMode?: EncryptionMode;
}): Promise<cordnClient> {
  return new cordnClient({
    privateKey: bytesToHex(params.privateKey),
    encryptionMode: params.encryptionMode ?? EncryptionMode.DISABLED,
    serverPubkey: params.serverPubkey,
    relayHandler: params.relayHandler,
  });
}

interface PostedCatchUp {
  gid: string;
  postedCursors: number[];
  originalBytes: Uint8Array[];
}

/**
 * Posts a sequence of application messages large enough that the fetch response
 * aggregates past the oversized threshold, returning what the client must later
 * be able to reconstruct byte-for-byte.
 */
async function postOversizedCatchUp(params: {
  sender: cordnClient;
  senderState: import("../coordinator/testUtils.ts").JoinedMemberArtifacts["state"];
}): Promise<PostedCatchUp> {
  let state = params.senderState;
  const postedCursors: number[] = [];
  const originalBytes: Uint8Array[] = [];
  let gid = "";

  for (let i = 0; i < CATCH_UP_MESSAGE_COUNT; i++) {
    const created = await createApplicationMessageBytes({
      state,
      plaintext: String.fromCharCode("a".charCodeAt(0) + i).repeat(
        PER_MESSAGE_PLAINTEXT_BYTES,
      ),
    });
    state = created.newState;

    const posted = await params.sender.PostGroupMessage({
      msg_64: encodeBase64(created.encodedMessage),
    });

    gid = posted.gid;
    postedCursors.push(posted.cursor);
    originalBytes.push(created.encodedMessage);
  }

  return { gid, postedCursors, originalBytes };
}

function expectCatchUpIntegrity(
  fetched: { messages: Array<{ cursor: number; gid: string; msg_64: string }> },
  expected: PostedCatchUp,
): void {
  expect(fetched.messages).toHaveLength(expected.postedCursors.length);
  expect(fetched.messages.map((message) => message.cursor)).toEqual(
    expected.postedCursors,
  );
  for (const [index, message] of fetched.messages.entries()) {
    expect(message.gid).toBe(expected.gid);
    const decoded = decodeBase64(message.msg_64);
    expect(decoded.byteLength).toBe(expected.originalBytes[index]!.byteLength);
    expect(Array.from(decoded)).toEqual(
      Array.from(expected.originalBytes[index]!),
    );
  }
}

/**
 * Races a promise against a deadline so a stalled oversized transfer fails the
 * test quickly instead of waiting for the SDK's 60s request timeout. A working
 * oversized catch-up completes in well under a second, so the deadline only
 * trips when the transfer is genuinely broken.
 */
async function resolveWithin<T>(
  promise: Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  // Prevent the eventual SDK request-timeout rejection from surfacing as an
  // unhandled rejection after the race has already settled.
  promise.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${label} did not complete within ${deadlineMs}ms (oversized transfer stalled)`,
        ),
      );
    }, deadlineMs);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe("oversized catch-up transfer (CEP-22)", () => {
  const clients: cordnClient[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      clients.splice(0).map((client) => client.disconnect()),
    );
  });

  test("FetchGroupMessages round-trips an oversized catch-up payload with encryption disabled", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const scenario = await createThreeActorGroupScenario();

      const aliceClient = await createClient({
        privateKey: scenario.alice.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bobClient = await createClient({
        privateKey: scenario.bob.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });

      clients.push(aliceClient, bobClient);

      const expected = await postOversizedCatchUp({
        sender: aliceClient,
        senderState: scenario.alice.state,
      });

      const fetched = await resolveWithin(
        bobClient.FetchGroupMessages({ gid: expected.gid }),
        20_000,
        "FetchGroupMessages (encryption disabled)",
      );

      expectCatchUpIntegrity(fetched, expected);
    } finally {
      await server.transport.close();
    }
  }, 30_000);

  test("FetchManyGroupMessages round-trips an oversized multi-group catch-up payload with encryption disabled", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const scenario = await createThreeActorGroupScenario();

      const aliceClient = await createClient({
        privateKey: scenario.alice.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });
      const bobClient = await createClient({
        privateKey: scenario.bob.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
      });

      clients.push(aliceClient, bobClient);

      const expected = await postOversizedCatchUp({
        sender: aliceClient,
        senderState: scenario.alice.state,
      });

      const fetched = await resolveWithin(
        bobClient.FetchManyGroupMessages({
          groups: [{ gid: expected.gid }],
        }),
        20_000,
        "FetchManyGroupMessages (encryption disabled)",
      );

      expectCatchUpIntegrity(fetched, expected);
    } finally {
      await server.transport.close();
    }
  }, 30_000);

  // Regression guard for the gift-wrap + oversized catch-up bug fixed in
  // @contextvm/sdk 0.12.3.
  //
  // History: under NIP-59 gift-wrap encryption, an aggregated catch-up response
  // that exceeded the ~48KB oversized threshold was never delivered. On 0.12.2
  // the server published only the gift-wrapped oversized start frame (a single
  // ~1KB kind-1059 event) and no chunk frames, so the client's request timed
  // out. With encryption disabled the identical scenario round-tripped correctly
  // (see the test above). On 0.12.3 the chunked frames are emitted and
  // reassembled correctly under both wrap kinds (1059 / 21059).
  test("FetchGroupMessages round-trips an oversized catch-up payload under gift-wrap encryption", async () => {
    const relayHub = new MockRelayHub();
    const serverSigner = new PrivateKeySigner();
    const serverPubkey = await serverSigner.getPublicKey();
    const server = await connectServer({
      signer: serverSigner,
      relayHandler: relayHub.createRelayHandler(),
    });

    try {
      const scenario = await createThreeActorGroupScenario();

      const aliceClient = await createClient({
        privateKey: scenario.alice.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        encryptionMode: EncryptionMode.OPTIONAL,
      });
      const bobClient = await createClient({
        privateKey: scenario.bob.actor.secretKey,
        serverPubkey,
        relayHandler: relayHub.createRelayHandler(),
        encryptionMode: EncryptionMode.OPTIONAL,
      });

      clients.push(aliceClient, bobClient);

      const expected = await postOversizedCatchUp({
        sender: aliceClient,
        senderState: scenario.alice.state,
      });

      const fetched = await resolveWithin(
        bobClient.FetchGroupMessages({ gid: expected.gid }),
        20_000,
        "FetchGroupMessages (gift-wrap encryption)",
      );

      expectCatchUpIntegrity(fetched, expected);
    } finally {
      await server.transport.close();
    }
  }, 30_000);
});
