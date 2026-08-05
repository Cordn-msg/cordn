import { base64 } from "@scure/base";

export function decodeBase64(value: string): Uint8Array {
  // Validate charset + padding length in one pass, then decode. Replaces a
  // decode -> re-encode -> string-compare round-trip that ran two base64 passes
  // plus a full-input regex scan on every inbound message. Same rejection
  // criteria as before: empty/whitespace-only and non-canonical input throw.
  const normalized = value.replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ||
    normalized.length % 4 !== 0
  ) {
    throw new Error("Invalid base64 payload");
  }

  const decoded = base64.decode(normalized);
  if (decoded.length === 0) {
    throw new Error("Invalid base64 payload");
  }

  return decoded;
}

export function encodeBase64(value: Uint8Array): string {
  return base64.encode(value);
}

export function assertNonEmptyBase64(
  value: string,
  fieldName: string,
): Uint8Array {
  const decoded = decodeBase64(value);
  if (decoded.length === 0) {
    throw new Error(
      `Invalid ${fieldName}: base64 payload decoded to empty bytes`,
    );
  }

  return decoded;
}
