import type { CustomExtension, KeyPackage } from "ts-mls";

export const LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE = 0x0004;

const LAST_RESORT_KEY_PACKAGE_EXTENSION = {
  extensionType: LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE,
  extensionData: new Uint8Array(),
} as CustomExtension;

export function ensureLastResortKeyPackageExtension(
  extensions: CustomExtension[],
): CustomExtension[] {
  if (extensions.some(isLastResortKeyPackageExtension)) {
    return extensions;
  }

  return [...extensions, LAST_RESORT_KEY_PACKAGE_EXTENSION];
}

export function isLastResortKeyPackage(keyPackage: KeyPackage): boolean {
  return keyPackage.extensions.some(isLastResortKeyPackageExtension);
}

export function isLastResortKeyPackageExtension(
  extension: CustomExtension,
): boolean {
  if (extension.extensionType !== LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE) {
    return false;
  }

  if (extension.extensionData.length !== 0) {
    throw new Error("Invalid last-resort key package extension data");
  }

  return true;
}
