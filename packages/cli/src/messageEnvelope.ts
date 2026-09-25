import { getEventHash, type UnsignedEvent } from "nostr-tools";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ENVELOPE_ID = /^[0-9a-fA-F]{64}$/;

export interface CordnMessageEnvelope extends UnsignedEvent {
  id: string;
}

export function createUnsignedCordnMessageEvent(params: {
  pubkey: string;
  content: string;
  createdAt?: number;
  kind?: number;
  tags?: string[][];
}): UnsignedEvent {
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt ?? Math.floor(Date.now() / 1000),
    kind: params.kind ?? 9,
    tags: params.tags ?? [],
    content: params.content,
  };
}

export function finalizeCordnMessageEvent(
  event: UnsignedEvent,
): CordnMessageEnvelope {
  return {
    ...event,
    id: getEventHash(event),
  };
}

export function encodeCordnMessageEvent(
  event: CordnMessageEnvelope,
): Uint8Array {
  return encoder.encode(JSON.stringify(event));
}

export function decodeCordnMessageEvent(
  bytes: Uint8Array,
): CordnMessageEnvelope {
  const parsed = JSON.parse(decoder.decode(bytes)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid cordn message envelope");
  }

  const candidate = parsed as Record<string, unknown>;
  if ("sig" in candidate) {
    throw new Error("Cordn message envelope must not include sig");
  }

  if (typeof candidate["id"] !== "string") {
    throw new Error("Invalid cordn message envelope");
  }

  const unsigned = candidate as UnsignedEvent;
  const id = getEventHash(unsigned);
  if (candidate["id"] !== id) {
    throw new Error("Cordn message envelope id mismatch");
  }

  if (!Array.isArray(unsigned.tags)) {
    throw new Error("Invalid cordn message envelope tags");
  }
  for (const tag of unsigned.tags) {
    // prev values MUST be valid envelope ids in the one-parent-per-tag shape
    // (coordinator-handoff.md §6.1, §14).
    if (!Array.isArray(tag) || tag[0] !== "prev") continue;
    if (
      tag.length !== 2 ||
      typeof tag[1] !== "string" ||
      !ENVELOPE_ID.test(tag[1])
    ) {
      throw new Error("Cordn message envelope has an invalid prev tag");
    }
  }

  return { ...unsigned, id };
}

/** The `prev` targets named by a record's tags (coordinator-handoff.md §6.1). */
export function prevLinksOf(tags: UnsignedEvent["tags"]): string[] {
  return tags.filter((tag) => tag[0] === "prev").map((tag) => tag[1]!);
}

/**
 * Tips of the known causal DAG (coordinator-handoff.md §2, §6.3): ids no
 * known record links as a parent. Recomputed from scratch, so re-sent
 * duplicates (§6.2) and arrival order cannot resurrect old tips.
 */
export function causalTips(
  messages: Iterable<{ id: string; tags: UnsignedEvent["tags"] }>,
): string[] {
  const known = new Set<string>();
  const referenced = new Set<string>();
  for (const message of messages) {
    known.add(message.id);
    for (const parent of prevLinksOf(message.tags)) referenced.add(parent);
  }
  return [...known].filter((id) => !referenced.has(id));
}

/** `prev` tags linking every tip of the known DAG (coordinator-handoff.md §6.3). */
export function causalPrevTags(
  messages: Iterable<{ id: string; tags: UnsignedEvent["tags"] }>,
): UnsignedEvent["tags"] {
  return causalTips(messages).map((id) => ["prev", id]);
}
