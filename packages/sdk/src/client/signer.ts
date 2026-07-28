import type { NostrEvent } from "nostr-tools";

/**
 * NIP-07-shaped signer (the interface, not the `window.nostr` binding). Browser
 * apps implement over `window.nostr`; Node/native apps over a private key.
 * The SDK signs only the authed channel with this identity; the ephemeral
 * channel uses an SDK-managed key (design #2, #3).
 */
export interface CordnUnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface CordnSigner {
  /** Stable hex pubkey — the BasicCredential identity (spec §6). */
  getPublicKey(): Promise<string>;
  /** Sign a Nostr event (authed-channel transport + key-package publication). */
  signEvent(event: CordnUnsignedEvent): Promise<NostrEvent>;
}
