const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function normalizePubkey(pubkey: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    throw new Error(`Invalid pubkey: ${pubkey}`);
  }
  return pubkey.trim().toLowerCase();
}

export interface CoordinatorLocator {
  pubkey: string;
  relayUrls: string[];
}

export interface HandoffRecord {
  from: CoordinatorLocator;
  /** Envelope `id` values of the closing commit's `boundary_tips` (§4.4). */
  boundaryTips: string[];
}

export interface CordnCoordinatorRouting {
  active: CoordinatorLocator;
  fallbacks: CoordinatorLocator[];
  handoffs: HandoffRecord[];
}

const ENVELOPE_ID = /^[0-9a-f]{64}$/;

function encodeUint16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`Value out of uint16 range: ${value}`);
  }

  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function decodeUint16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) {
    throw new Error(
      "Unexpected end of cordn coordinator routing while reading uint16",
    );
  }

  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function encodeField(bytes: Uint8Array): Uint8Array {
  return new Uint8Array([...encodeUint16(bytes.length), ...bytes]);
}

function decodeField(bytes: Uint8Array, offset: number): [Uint8Array, number] {
  const length = decodeUint16(bytes, offset);
  const start = offset + 2;
  const end = start + length;

  if (end > bytes.length) {
    throw new Error(
      "Unexpected end of cordn coordinator routing while reading field",
    );
  }

  return [bytes.slice(start, end), end];
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(parts.flatMap((part) => Array.from(part)));
}

function normalizeEnvelopeId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!ENVELOPE_ID.test(normalized)) {
    throw new Error(`Invalid envelope id: ${id}`);
  }
  return normalized;
}

function normalizeLocator(locator: CoordinatorLocator): CoordinatorLocator {
  return {
    pubkey: normalizePubkey(locator.pubkey),
    relayUrls: locator.relayUrls.map((url) => {
      const trimmed = url.trim();
      if (!trimmed) {
        throw new Error("Relay URLs must be non-empty");
      }
      return trimmed;
    }),
  };
}

function encodeLocator(locator: CoordinatorLocator): Uint8Array {
  const relays = concat(
    ...locator.relayUrls.map((url) => encodeField(encoder.encode(url))),
  );
  return concat(Buffer.from(locator.pubkey, "hex"), encodeField(relays));
}

function encodeHandoff(record: HandoffRecord): Uint8Array {
  const tips = concat(
    ...record.boundaryTips.map((id) => encodeField(encoder.encode(id))),
  );
  return concat(encodeLocator(record.from), encodeField(tips));
}

function decodeStrings(bytes: Uint8Array): string[] {
  const values: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [value, next] = decodeField(bytes, offset);
    values.push(decoder.decode(value));
    offset = next;
  }
  return values;
}

function decodeLocator(
  bytes: Uint8Array,
  offset: number,
): [CoordinatorLocator, number] {
  const end = offset + 32;
  if (end > bytes.length) {
    throw new Error(
      "Unexpected end of cordn coordinator routing while reading locator",
    );
  }
  const pubkey = Buffer.from(bytes.slice(offset, end)).toString("hex");
  const [relays, next] = decodeField(bytes, end);
  return [normalizeLocator({ pubkey, relayUrls: decodeStrings(relays) }), next];
}

function decodeLocators(bytes: Uint8Array): CoordinatorLocator[] {
  const locators: CoordinatorLocator[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [locator, next] = decodeLocator(bytes, offset);
    locators.push(locator);
    offset = next;
  }
  return locators;
}

function decodeHandoffs(bytes: Uint8Array): HandoffRecord[] {
  const records: HandoffRecord[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [from, afterFrom] = decodeLocator(bytes, offset);
    const [tips, next] = decodeField(bytes, afterFrom);
    records.push({
      from,
      boundaryTips: decodeStrings(tips).map(normalizeEnvelopeId),
    });
    offset = next;
  }
  return records;
}

export function encodeCordnCoordinatorRouting(
  routing: CordnCoordinatorRouting,
): Uint8Array {
  const fallbacks = routing.fallbacks.map(normalizeLocator);
  const handoffs = routing.handoffs.map((record) => ({
    from: normalizeLocator(record.from),
    boundaryTips: record.boundaryTips.map(normalizeEnvelopeId),
  }));

  return concat(
    encodeUint16(1),
    encodeLocator(normalizeLocator(routing.active)),
    encodeField(concat(...fallbacks.map(encodeLocator))),
    encodeField(concat(...handoffs.map(encodeHandoff))),
  );
}

export function decodeCordnCoordinatorRouting(
  bytes: Uint8Array,
): CordnCoordinatorRouting {
  let offset = 0;
  const version = decodeUint16(bytes, offset);
  offset += 2;

  if (version === 0) {
    throw new Error("Reserved cordn coordinator routing version: 0");
  }

  const [active, afterActive] = decodeLocator(bytes, offset);
  offset = afterActive;
  const [fallbacksBlob, afterFallbacks] = decodeField(bytes, offset);
  offset = afterFallbacks;
  const [handoffsBlob, afterHandoffs] = decodeField(bytes, offset);
  offset = afterHandoffs;

  const fallbacks = decodeLocators(fallbacksBlob);

  if (version === 1 && offset !== bytes.length) {
    throw new Error("Unexpected trailing bytes in cordn coordinator routing");
  }

  return { active, fallbacks, handoffs: decodeHandoffs(handoffsBlob) };
}
