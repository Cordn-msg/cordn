/**
 * Hardened Nostr tip transport (spec/applications/multi-device.md §6, §11).
 *
 * The tip is a NIP-33 parameterized replaceable event signed by an ephemeral
 * keypair INDEPENDENT of the owner identity. Its `content` is a NIP-44 seal
 * (to the owner npub) of an inner event signed by the owner npub that points
 * at the current session document: `x` = sha256 of the sealed blob, ordered
 * `server` tags = Blossom URLs. The owner npub never appears in the clear on
 * the network — only the ephemeral pubkey is relayed; the owner npub lives
 * only inside the NIP-44 seal.
 *
 * This is the RECOMMENDED tip transport. The document layer (`multiDevice.ts`)
 * is tip-transport-agnostic: any mechanism resolving "current document address
 * for this owner" interops, because the tip is a lookup, not a protocol
 * primitive (spec §6).
 */
import { randomBytes } from "node:crypto";

import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  type EventTemplate,
  type NostrEvent,
} from "nostr-tools/pure";
import { nip19, nip44 } from "nostr-tools";
import type { RelayHandler } from "@contextvm/sdk";

/** Default outer (replaceable) event kind. Spec §6; exact kind is a §14 detail. */
export const DEFAULT_TIP_KIND = 30078;
/** Default inner (sealed) event kind. Spec §6; self-labeling (never relayed). */
export const DEFAULT_TIP_INNER_KIND = 178;

export interface TipGroupPointer {
  /** Group document content address (spec §6 `x` tagged `group`). */
  address: string;
  /** Delivery group id the document is for — enables fetch-only-changed. */
  gid: string;
}

export interface TipPointer {
  /** One pointer per live group document (spec §6: `['x', h, 'group', gid]`). */
  groups: TipGroupPointer[];
  /** Meta document content address, if any (spec §6: `['x', h, 'meta']`). */
  metaAddress?: string;
  /** Ordered Blossom server URLs hosting the blobs (spec §6 `server`). */
  servers: string[];
}

export interface NostrTipStoreOptions {
  relayHandler: RelayHandler;
  /** Owner secp256k1 private key: signs the inner event + NIP-44 decrypt key. */
  ownerPrivateKey: Uint8Array;
  /** Owner npub (hex): NIP-44 target and inner-event signer. */
  ownerPubkey: string;
  /** Ephemeral private key. Generated if absent (spec §6: independent of owner). */
  ephemeralPrivateKey?: Uint8Array;
  /** Stable `d` tag (opaque). Generated if absent; reused across republishes. */
  d?: string;
  kind?: number;
  innerKind?: number;
}

export class NostrTipStore {
  readonly ownerPubkey: string;
  readonly kind: number;
  readonly innerKind: number;
  readonly ephemeralPubkey: string;
  readonly d: string;
  private readonly relayHandler: RelayHandler;
  private readonly ownerPrivateKey: Uint8Array;
  private readonly ephemeralPrivateKey: Uint8Array;
  private lastCreatedAt = 0;

  constructor(opts: NostrTipStoreOptions) {
    this.relayHandler = opts.relayHandler;
    this.ownerPrivateKey = opts.ownerPrivateKey;
    this.ownerPubkey = opts.ownerPubkey;
    // Spec §6: the ephemeral key MUST be independent of the owner nsec — so it
    // is generated randomly, never derived. ponytail: a caller reusing a store
    // passes it explicitly; a fresh device gets it from the connection string.
    this.ephemeralPrivateKey = opts.ephemeralPrivateKey ?? randomBytes(32);
    this.ephemeralPubkey = getPublicKey(this.ephemeralPrivateKey);
    this.d = opts.d ?? randomBytes(32).toString("hex");
    this.kind = opts.kind ?? DEFAULT_TIP_KIND;
    this.innerKind = opts.innerKind ?? DEFAULT_TIP_INNER_KIND;
  }

  /** Next monotonic created_at so a republish always supersedes the prior. */
  private nextCreatedAt(): number {
    const t = Math.max(Date.now(), this.lastCreatedAt + 1);
    this.lastCreatedAt = t;
    return t;
  }

  /**
   * Replace the tip to point at `pointer`. Builds the owner-signed inner event,
   * NIP-44-seals it to the owner npub, wraps it in the ephemeral-signed outer
   * replaceable event, and publishes. Returns the outer event.
   */
  async publishTip(pointer: TipPointer): Promise<NostrEvent> {
    const createdAt = this.nextCreatedAt();
    const inner: EventTemplate = {
      kind: this.innerKind,
      content: "",
      created_at: createdAt,
      tags: [
        ...pointer.groups.map(
          (g) => ["x", g.address, "group", g.gid] as string[],
        ),
        ...(pointer.metaAddress
          ? ([["x", pointer.metaAddress, "meta"]] as string[][])
          : []),
        ...pointer.servers.map((s) => ["server", s] as string[]),
      ],
    };
    const innerEvent = finalizeEvent(inner, this.ownerPrivateKey);

    const conversationKey = nip44.getConversationKey(
      this.ownerPrivateKey,
      this.ownerPubkey,
    );
    const seal = nip44.encrypt(JSON.stringify(innerEvent), conversationKey);

    const outer: EventTemplate = {
      kind: this.kind,
      content: seal,
      created_at: createdAt,
      tags: [["d", this.d]],
    };
    const outerEvent = finalizeEvent(outer, this.ephemeralPrivateKey);
    await this.relayHandler.publish(outerEvent);
    return outerEvent;
  }

  /**
   * Read the current tip: subscribe to the outer replaceable event by
   * (ephemeral pubkey, d), take the greatest created_at, NIP-44-decrypt its
   * content, verify the inner event's owner signature, and return the pointer.
   * Returns null if no tip exists yet.
   */
  async readTip(): Promise<TipPointer | null> {
    const events: NostrEvent[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const unsub = await this.relayHandler.subscribe(
      [
        {
          kinds: [this.kind],
          authors: [this.ephemeralPubkey],
          "#d": [this.d],
        },
      ],
      (event) => events.push(event),
      resolveDone,
    );
    unsub();
    await done;

    if (events.length === 0) return null;
    const latest = events.reduce((a, b) =>
      b.created_at > a.created_at ? b : a,
    );

    const conversationKey = nip44.getConversationKey(
      this.ownerPrivateKey,
      this.ownerPubkey,
    );
    const innerJson = nip44.decrypt(latest.content, conversationKey);
    const inner = JSON.parse(innerJson) as NostrEvent;
    if (inner.pubkey !== this.ownerPubkey) {
      throw new Error("Tip inner event not signed by the owner");
    }
    if (!verifyEvent(inner)) {
      throw new Error("Tip inner event signature invalid");
    }
    const groups: TipGroupPointer[] = [];
    let metaAddress: string | undefined;
    for (const tag of inner.tags) {
      if (tag[0] !== "x") continue;
      if (tag[2] === "group") {
        if (typeof tag[1] === "string" && typeof tag[3] === "string") {
          groups.push({ address: tag[1], gid: tag[3] });
        }
      } else if (tag[2] === "meta" && typeof tag[1] === "string") {
        metaAddress = tag[1];
      }
    }
    if (groups.length === 0 && metaAddress === undefined) {
      throw new Error("Tip inner event has no x tags");
    }
    const servers = inner.tags
      .filter((t) => t[0] === "server")
      .map((t) => t[1])
      .filter((s): s is string => typeof s === "string");
    return { groups, metaAddress, servers };
  }

  /**
   * Connection string (spec §11): a NIP-19 `naddr` locator (kind + ephemeral
   * pubkey + `d` + relay hints) joined with the ephemeral `nsec` write key.
   * Minted by an existing device; a new device bootstraps from it alone. Its
   * leak enables tip denial-of-service only (§6, §13). Separator `::` is not in
   * the bech32 charset, so it cannot appear inside either component.
   */
  toConnectionString(relays: string[]): string {
    const naddr = nip19.naddrEncode({
      identifier: this.d,
      pubkey: this.ephemeralPubkey,
      kind: this.kind,
      relays,
    });
    const nsec = nip19.nsecEncode(this.ephemeralPrivateKey);
    return `${naddr}::${nsec}`;
  }

  /**
   * Bootstrap a store from a connection string minted by another device. The
   * reading device supplies its own owner key (it has the `nsec`); the string
   * carries only the ephemeral locator + write key. See spec §11.
   */
  static fromConnectionString(
    connection: string,
    opts: {
      relayHandler: RelayHandler;
      ownerPrivateKey: Uint8Array;
      ownerPubkey: string;
    },
  ): NostrTipStore {
    const parts = connection.split("::");
    if (parts.length !== 2) {
      throw new Error("Invalid connection string");
    }
    const addr = nip19.decode(parts[0]!);
    const sec = nip19.decode(parts[1]!);
    if (addr.type !== "naddr" || sec.type !== "nsec") {
      throw new Error("Invalid connection string components");
    }
    return new NostrTipStore({
      relayHandler: opts.relayHandler,
      ownerPrivateKey: opts.ownerPrivateKey,
      ownerPubkey: opts.ownerPubkey,
      ephemeralPrivateKey: sec.data,
      d: addr.data.identifier,
      kind: addr.data.kind,
    });
  }
}
