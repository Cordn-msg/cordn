import {
  createApplicationMessage,
  encode,
  mlsExporter,
  mlsMessageDecoder,
  mlsMessageEncoder,
  processMessage,
  unsafeTestingAuthenticationService,
  type IncomingMessageCallback,
  type ClientState,
} from "ts-mls";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes, randomBytes } from "@noble/ciphers/utils.js";

import {
  encodeCordnMessageEvent,
  finalizeCordnMessageEvent,
  type CordnMessageEnvelope,
} from "../messageEnvelope.ts";
import {
  cliClientConfig,
  decodeBase64,
  encodeBase64,
  getCliCiphersuite,
} from "./mlsBase.ts";
import { InvalidMlsMessageError } from "../sessionErrors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createApplicationMessageBase64(params: {
  state: ClientState;
  event: Omit<CordnMessageEnvelope, "id">;
  authenticatedData?: Uint8Array;
}): Promise<{
  newState: ClientState;
  opaqueMessageBase64: string;
  event: CordnMessageEnvelope;
}> {
  const cipherSuite = await getCliCiphersuite();
  const event = finalizeCordnMessageEvent(params.event);
  const result = await createApplicationMessage({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: params.state,
    message: encodeCordnMessageEvent(event),
    authenticatedData: params.authenticatedData,
  });

  return {
    newState: result.newState,
    opaqueMessageBase64: encodeBase64(
      encode(mlsMessageEncoder, result.message),
    ),
    event,
  };
}

export async function processMessageBase64(params: {
  state: ClientState;
  opaqueMessageBase64: string;
  callback?: IncomingMessageCallback;
}): Promise<Awaited<ReturnType<typeof processMessage>>> {
  const cipherSuite = await getCliCiphersuite();
  const decoded = mlsMessageDecoder(
    decodeBase64(params.opaqueMessageBase64),
    0,
  );

  if (!decoded) {
    throw new InvalidMlsMessageError();
  }

  if (decoded[0].wireformat !== 2 && decoded[0].wireformat !== 1) {
    throw new InvalidMlsMessageError("Expected framed MLS message");
  }

  return processMessage({
    context: {
      cipherSuite,
      authService: unsafeTestingAuthenticationService,
      clientConfig: cliClientConfig,
    },
    state: params.state,
    message: decoded[0],
    callback: params.callback,
  });
}

/**
 * Encrypt a serialized MLS message with ChaCha20-Poly1305 using a key
 * derived from the current MLS epoch's exporter secret.
 *
 * Wire format: base64(12-byte-nonce || ChaCha20-Poly1305-ciphertext-with-16-byte-auth-tag)
 */
export async function encryptGroupPayload(params: {
  state: ClientState;
  serializedMlsMessage: Uint8Array;
}): Promise<{ encryptedBase64: string }> {
  const cipherSuite = await getCliCiphersuite();
  const key = await mlsExporter(
    params.state.keySchedule.exporterSecret,
    "cordn",
    encoder.encode("group-payload"),
    32,
    cipherSuite,
  );
  const nonce = randomBytes(12);
  const ciphertext = chacha20poly1305(key, nonce, new Uint8Array(0)).encrypt(
    params.serializedMlsMessage,
  );
  const encryptedBase64 = encodeBase64(concatBytes(nonce, ciphertext));
  return { encryptedBase64 };
}

/**
 * Decrypt a ChaCha20-Poly1305 encrypted payload wrapper around a serialized
 * MLS message. Returns the plaintext MLS bytes for downstream MLS processing.
 */
export async function decryptGroupPayload(params: {
  state: ClientState;
  encryptedBase64: string;
}): Promise<{ serializedMlsMessage: Uint8Array }> {
  const cipherSuite = await getCliCiphersuite();
  const payload = decodeBase64(params.encryptedBase64);
  const nonce = payload.subarray(0, 12);
  const ciphertext = payload.subarray(12);
  const key = await mlsExporter(
    params.state.keySchedule.exporterSecret,
    "cordn",
    encoder.encode("group-payload"),
    32,
    cipherSuite,
  );
  const serializedMlsMessage = chacha20poly1305(
    key,
    nonce,
    new Uint8Array(0),
  ).decrypt(ciphertext);
  return { serializedMlsMessage };
}

export function encodeAuthenticatedSender(stablePubkey: string): Uint8Array {
  return encoder.encode(stablePubkey);
}

export function decodeAuthenticatedSender(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
