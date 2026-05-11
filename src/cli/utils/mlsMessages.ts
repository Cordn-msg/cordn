import {
  createApplicationMessage,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  processMessage,
  unsafeTestingAuthenticationService,
  type ClientState,
} from "ts-mls";

import {
  encodeCordnMessageEvent,
  finalizeCordnMessageEvent,
  type CordnMessageEnvelope,
} from "../messageEnvelope.ts";
import { decodeBase64, encodeBase64, getCliCiphersuite } from "./mlsBase.ts";
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
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: params.state,
    message: decoded[0],
  });
}

export function encodeAuthenticatedSender(stablePubkey: string): Uint8Array {
  return encoder.encode(stablePubkey);
}

export function decodeAuthenticatedSender(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
