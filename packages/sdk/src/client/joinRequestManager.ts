import type { CordnTransport, JoinRequestItem } from "../transport.ts";
import type { CordnSigner } from "./signer.ts";

export interface StoreJoinRequestOptions {
  groupId: string;
  keyPackageRef: string;
}

/**
 * Join-request primitives (decision #7 — no loop imposition). A group admin
 * fetches pending requests; a prospective member stores one. Consumed-ref ack
 * is handled at the transport/coordinator level.
 */
export class JoinRequestManager {
  constructor(
    private readonly opts: { signer: CordnSigner; transport: CordnTransport },
  ) {}

  /** A group admin fetches pending join requests for a group they administer. */
  async fetch(groupId: string): Promise<JoinRequestItem[]> {
    return this.opts.transport.fetchPendingJoinRequests(groupId);
  }

  /** A prospective member posts a join request (requester = this signer). */
  async store(input: StoreJoinRequestOptions): Promise<JoinRequestItem> {
    const requesterStablePubkey = await this.opts.signer.getPublicKey();
    return this.opts.transport.storeJoinRequest({
      ...input,
      requesterStablePubkey,
    });
  }
}
