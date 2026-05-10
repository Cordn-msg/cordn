import { verifyEvent, type NostrEvent } from "nostr-tools";
import { isDefaultCredential, type KeyPackage } from "ts-mls";

import { decodeKeyPackage } from "../../mlsCodec.ts";
import { assertNonEmptyBase64 } from "../../server/base64.ts";

function decodeStablePubkeyIdentity(keyPackage: KeyPackage): string {
  const credential = keyPackage.leafNode.credential;
  if (
    !isDefaultCredential(credential) ||
    credential.credentialType !== 1 ||
    !("identity" in credential)
  ) {
    throw new Error("Only BasicCredential key packages are supported");
  }

  return new TextDecoder().decode(credential.identity);
}

function readKeyPackageBase64FromPublicationEvent(
  publicationEvent: NostrEvent,
): Uint8Array {
  const parsed = JSON.parse(publicationEvent.content);
  const keyPackageBase64 =
    parsed.params?.arguments?.kp_64 ??
    parsed.params?.arguments?.keyPackageBase64;
  if (typeof keyPackageBase64 !== "string") {
    throw new Error("Missing kp_64 in publication event");
  }

  return assertNonEmptyBase64(
    keyPackageBase64,
    "publicationEvent.params.arguments.kp_64",
  );
}

export async function parsePublishedKeyPackageEvent(
  publicationEvent: NostrEvent,
): Promise<{ stablePubkey: string; keyPackage: KeyPackage }> {
  if (!verifyEvent(publicationEvent)) {
    throw new Error("Invalid publication event signature");
  }

  const keyPackage = decodeKeyPackage(
    readKeyPackageBase64FromPublicationEvent(publicationEvent),
    "publicationEvent.content",
  );
  const stablePubkey = decodeStablePubkeyIdentity(keyPackage);
  if (stablePubkey !== publicationEvent.pubkey) {
    throw new Error(
      "Key package credential identity does not match publication event signer",
    );
  }

  return { stablePubkey, keyPackage };
}

export async function parseConsumedKeyPackage(keyPackage: {
  stablePubkey: string;
  publicationEvent: NostrEvent;
}): Promise<KeyPackage> {
  const parsed = await parsePublishedKeyPackageEvent(
    keyPackage.publicationEvent,
  );
  if (parsed.stablePubkey !== keyPackage.stablePubkey) {
    throw new Error(
      "Consumed key package stable pubkey does not match publication event",
    );
  }

  return parsed.keyPackage;
}
