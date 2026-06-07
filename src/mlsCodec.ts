import {
  encode,
  keyPackageDecoder,
  keyPackageEncoder,
  mlsMessageDecoder,
  mlsMessageEncoder,
  protocolVersions,
  wireformats,
  type KeyPackage,
  type Welcome,
} from "ts-mls";

export type Decoder<T> = (
  bytes: Uint8Array,
  offset: number,
) => [T, number] | undefined;

export function decodeExact<T>(
  bytes: Uint8Array,
  decoder: Decoder<T>,
  label: string,
): T {
  const decoded = decoder(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length) {
    throw new Error(`Invalid ${label}`);
  }

  return decoded[0];
}

export function encodeKeyPackage(keyPackage: KeyPackage): Uint8Array {
  return encode(keyPackageEncoder, keyPackage);
}

export function decodeKeyPackage(
  bytes: Uint8Array,
  label = "key package",
): KeyPackage {
  return decodeExact(bytes, keyPackageDecoder, label);
}

export function encodeWelcome(welcome: Welcome): Uint8Array {
  return encode(mlsMessageEncoder, {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_welcome,
    welcome,
  });
}

export function decodeWelcome(bytes: Uint8Array, label = "welcome"): Welcome {
  const message = decodeExact(bytes, mlsMessageDecoder, label);
  if (message.wireformat !== wireformats.mls_welcome) {
    throw new Error(`Invalid ${label}`);
  }

  return message.welcome;
}
