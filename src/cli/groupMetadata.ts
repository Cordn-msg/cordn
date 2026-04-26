import {
  defaultCapabilities,
  makeCustomExtension,
  type Capabilities,
  type ClientState,
  type GroupContextExtension,
} from "ts-mls";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const CORDN_GROUP_METADATA_EXTENSION_TYPE = 0xc04d;

export interface CordnGroupMetadata {
  name: string;
  description?: string;
  adminPubkeys?: string[];
  icon?: string;
  imageUrl?: string;
}

interface NormalizedCordnGroupMetadata {
  version: number;
  name: string;
  description: string;
  adminPubkeys: string[];
  icon: string;
  imageUrl: string;
}

function encodeUint16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`Value out of uint16 range: ${value}`);
  }

  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function decodeUint16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) {
    throw new Error("Unexpected end of metadata while reading uint16");
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
    throw new Error("Unexpected end of metadata while reading field");
  }

  return [bytes.slice(start, end), end];
}

function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function encodeUtf8(value: string): Uint8Array {
  return encoder.encode(value);
}

function normalizeAdminPubkeys(adminPubkeys?: string[]): string[] {
  if (!adminPubkeys || adminPubkeys.length === 0) {
    return [];
  }

  const normalized = adminPubkeys.map((value) => value.trim()).filter(Boolean);
  const unique = new Set(normalized);

  if (unique.size !== normalized.length) {
    throw new Error("Group metadata admin pubkeys must not contain duplicates");
  }

  for (const value of normalized) {
    if (!/^[0-9a-fA-F]{64}$/.test(value)) {
      throw new Error(`Invalid admin pubkey: ${value}`);
    }
  }

  return normalized.map((value) => value.toLowerCase());
}

function normalizeCordnGroupMetadata(
  metadata: CordnGroupMetadata,
): NormalizedCordnGroupMetadata {
  if (metadata.name === undefined) {
    throw new Error(
      "Group metadata name is required when metadata is provided",
    );
  }

  return {
    version: 1,
    name: metadata.name,
    description: metadata.description ?? "",
    adminPubkeys: normalizeAdminPubkeys(metadata.adminPubkeys),
    icon: metadata.icon ?? "",
    imageUrl: metadata.imageUrl ?? "",
  };
}

function encodeAdminPubkeys(adminPubkeys: string[]): Uint8Array {
  const bytes = adminPubkeys.flatMap((value) =>
    Array.from(Buffer.from(value, "hex")),
  );
  return Uint8Array.from(bytes);
}

function decodeAdminPubkeys(bytes: Uint8Array): string[] {
  if (bytes.length % 32 !== 0) {
    throw new Error(
      "Group metadata admin_pubkeys length must be a multiple of 32",
    );
  }

  const values: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += 32) {
    values.push(Buffer.from(bytes.slice(offset, offset + 32)).toString("hex"));
  }

  return normalizeAdminPubkeys(values);
}

export function encodeCordnGroupMetadata(
  metadata: CordnGroupMetadata,
): Uint8Array {
  const normalized = normalizeCordnGroupMetadata(metadata);

  return new Uint8Array([
    ...encodeUint16(normalized.version),
    ...encodeField(encodeUtf8(normalized.name)),
    ...encodeField(encodeUtf8(normalized.description)),
    ...encodeField(encodeAdminPubkeys(normalized.adminPubkeys)),
    ...encodeField(encodeUtf8(normalized.icon)),
    ...encodeField(encodeUtf8(normalized.imageUrl)),
  ]);
}

export function decodeCordnGroupMetadata(
  bytes: Uint8Array,
): CordnGroupMetadata {
  let offset = 0;
  const version = decodeUint16(bytes, offset);
  offset += 2;

  if (version !== 1) {
    throw new Error(`Unsupported cordn group metadata version: ${version}`);
  }

  const [nameBytes, offsetAfterName] = decodeField(bytes, offset);
  const [descriptionBytes, offsetAfterDescription] = decodeField(
    bytes,
    offsetAfterName,
  );
  const [adminPubkeysBytes, offsetAfterAdmins] = decodeField(
    bytes,
    offsetAfterDescription,
  );
  const [iconBytes, offsetAfterIcon] = decodeField(bytes, offsetAfterAdmins);
  const [imageUrlBytes, finalOffset] = decodeField(bytes, offsetAfterIcon);

  if (finalOffset !== bytes.length) {
    throw new Error("Unexpected trailing bytes in cordn group metadata");
  }

  const adminPubkeys = decodeAdminPubkeys(adminPubkeysBytes);

  return {
    name: decodeUtf8(nameBytes),
    description: decodeUtf8(descriptionBytes) || undefined,
    adminPubkeys: adminPubkeys.length > 0 ? adminPubkeys : undefined,
    icon: decodeUtf8(iconBytes) || undefined,
    imageUrl: decodeUtf8(imageUrlBytes) || undefined,
  };
}

export function makeCordnGroupMetadataExtension(
  metadata: CordnGroupMetadata,
): GroupContextExtension {
  return makeCustomExtension({
    extensionType: CORDN_GROUP_METADATA_EXTENSION_TYPE,
    extensionData: encodeCordnGroupMetadata(metadata),
  });
}

export function getCordnGroupMetadataExtension(
  state: ClientState,
): CordnGroupMetadata | undefined {
  const extension = state.groupContext.extensions.find(
    (candidate) =>
      candidate.extensionType === CORDN_GROUP_METADATA_EXTENSION_TYPE,
  );

  if (!extension) {
    return undefined;
  }

  return decodeCordnGroupMetadata(extension.extensionData as Uint8Array);
}

export function createCordnMetadataCapabilities(): Capabilities {
  const capabilities = defaultCapabilities();

  if (!capabilities.extensions.includes(CORDN_GROUP_METADATA_EXTENSION_TYPE)) {
    capabilities.extensions = [
      ...capabilities.extensions,
      CORDN_GROUP_METADATA_EXTENSION_TYPE,
    ];
  }

  return capabilities;
}
