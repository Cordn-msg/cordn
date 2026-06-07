import { getEventHash, type UnsignedEvent } from 'nostr-tools';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
		content: params.content
	};
}

export function finalizeCordnMessageEvent(event: UnsignedEvent): CordnMessageEnvelope {
	return {
		...event,
		id: getEventHash(event)
	};
}

export function encodeCordnMessageEvent(event: CordnMessageEnvelope): Uint8Array {
	return encoder.encode(JSON.stringify(event));
}

export function decodeCordnMessageEvent(bytes: Uint8Array): CordnMessageEnvelope {
	const parsed = JSON.parse(decoder.decode(bytes)) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Invalid cordn message envelope');
	}

	const candidate = parsed as Record<string, unknown>;
	if ('sig' in candidate) {
		throw new Error('Cordn message envelope must not include sig');
	}

	if (typeof candidate['id'] !== 'string') {
		throw new Error('Invalid cordn message envelope');
	}

	const unsigned = candidate as UnsignedEvent;
	const id = getEventHash(unsigned);
	if (candidate['id'] !== id) {
		throw new Error('Cordn message envelope id mismatch');
	}

	return { ...unsigned, id };
}
