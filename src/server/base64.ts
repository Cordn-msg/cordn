export function decodeBase64(value: string): Uint8Array {
  if (value.trim() === "") {
    throw new Error("Invalid base64 payload");
  }

  const decoded = Uint8Array.from(Buffer.from(value, "base64"));
  const normalizedInput = value.replace(/\s+/g, "");

  if (
    decoded.length === 0 ||
    Buffer.from(decoded).toString("base64") !== normalizedInput
  ) {
    throw new Error("Invalid base64 payload");
  }

  return decoded;
}

export function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
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
