import {
  createApplicationMessage,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  processMessage,
  unsafeTestingAuthenticationService,
  type ClientState,
} from "ts-mls";

import { decodeBase64, encodeBase64, getCliCiphersuite } from "./mlsBase.ts";
import { InvalidMlsMessageError } from "../sessionErrors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createApplicationMessageBase64(params: {
  state: ClientState;
  plaintext: string;
  authenticatedData?: Uint8Array;
}): Promise<{ newState: ClientState; opaqueMessageBase64: string }> {
  const cipherSuite = await getCliCiphersuite();
  const result = await createApplicationMessage({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    state: params.state,
    message: encoder.encode(params.plaintext),
    authenticatedData: params.authenticatedData,
  });

  return {
    newState: result.newState,
    opaqueMessageBase64: encodeBase64(
      encode(mlsMessageEncoder, result.message),
    ),
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

export function decodeApplicationData(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function encodeAuthenticatedSender(stablePubkey: string): Uint8Array {
  return encoder.encode(stablePubkey);
}

export function decodeAuthenticatedSender(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
