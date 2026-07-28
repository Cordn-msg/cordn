import type { CordnTransport, WelcomeQueueItem } from "../transport.ts";
import type { CordnSigner } from "./signer.ts";

/**
 * Welcome-inbox primitives. Fetches this client's pending welcomes; the app
 * decides cadence (design #7 — no polling imposition). Consumed-ref handling
 * lives at the transport/coordinator level.
 */
export class InviteManager {
  constructor(
    private readonly opts: { signer: CordnSigner; transport: CordnTransport },
  ) {}

  /** Fetch pending welcomes addressed to this client. */
  async fetch(): Promise<WelcomeQueueItem[]> {
    const stablePubkey = await this.opts.signer.getPublicKey();
    return this.opts.transport.fetchPendingWelcomes(stablePubkey);
  }
}
