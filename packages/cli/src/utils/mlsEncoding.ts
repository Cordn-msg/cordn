import {
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  type Welcome,
} from "ts-mls";

import { decodeBase64, encodeBase64 } from "./mlsBase.ts";
import { InvalidWelcomeMessageError } from "../sessionErrors.ts";

export function decodeWelcomeBase64(welcomeBase64: string): Welcome {
  const decoded = mlsMessageDecoder(decodeBase64(welcomeBase64), 0);

  if (!decoded || decoded[0].wireformat !== 3) {
    throw new InvalidWelcomeMessageError();
  }

  return decoded[0].welcome;
}

export function encodeWelcomeBase64(welcome: Welcome): string {
  return encodeBase64(
    encode(mlsMessageEncoder, { version: 1, wireformat: 3, welcome }),
  );
}
