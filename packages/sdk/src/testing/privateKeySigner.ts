import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools";

import type { CordnSigner, CordnUnsignedEvent } from "../client/signer.ts";

/**
 * A {@link CordnSigner} backed by a raw Nostr secret key — for Node/tests.
 * Browser apps implement `CordnSigner` over `window.nostr` (NIP-07) instead.
 */
export class PrivateKeySigner implements CordnSigner {
  readonly pubkey: string;

  constructor(private readonly secretKey: Uint8Array) {
    this.pubkey = getPublicKey(secretKey);
  }

  async getPublicKey(): Promise<string> {
    return this.pubkey;
  }

  async signEvent(event: CordnUnsignedEvent): Promise<NostrEvent> {
    return finalizeEvent(
      {
        kind: event.kind,
        created_at: event.created_at,
        tags: event.tags,
        content: event.content,
      },
      this.secretKey,
    );
  }
}

/** Create a `PrivateKeySigner`, generating a fresh secret key if none given. */
export function createPrivateKeySigner(
  secretKey?: Uint8Array,
): PrivateKeySigner {
  return new PrivateKeySigner(secretKey ?? generateSecretKey());
}
