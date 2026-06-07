import { describe, expect, test } from 'vitest';

import type { SubscribeGroupMessagesInput } from '../contracts/index.ts';
import { runGroupWatch } from './groupWatch.ts';

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error('Timed out waiting for condition');
		}

		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('runGroupWatch', () => {
	test('fetches first and then streams subsequent live messages', async () => {
		const seen: string[] = [];
		let releaseLiveMessage: (() => void) | undefined;
		const stream: AsyncIterable<{
			cursor: number;
			gid: string;
			at: number;
			msg_64: string;
		}> = {
			async *[Symbol.asyncIterator]() {
				await new Promise<void>((resolve) => {
					releaseLiveMessage = resolve;
				});

				yield {
					cursor: 5,
					gid: 'demo',
					at: 101,
					msg_64: 'live-1'
				};
			}
		};

		const watch = runGroupWatch({
			client: {
				SubscribeGroupMessages: async () => ({
					stream,
					result: Promise.resolve({ subscribed: true }),
					abort: async () => undefined
				})
			} as never,
			groupId: 'demo',
			getAfterCursor: () => 3,
			fetchMessages: async () => [
				{
					cursor: 4,
					gid: 'demo',
					at: 100,
					msg_64: 'catchup'
				}
			],
			callbacks: {
				onConnecting: () => {
					seen.push('connecting');
				},
				onWatching: () => {
					seen.push('watching');
				},
				onMessages: async (messages) => {
					seen.push(`messages:${messages.length}`);
				}
			}
		});

		await waitForCondition(() => releaseLiveMessage !== undefined);
		releaseLiveMessage?.();
		await watch.task;

		expect(seen).toEqual(['connecting', 'messages:1', 'watching', 'messages:1']);
	});

	test('subscribes from the cursor after catchup ingestion advances progress', async () => {
		const subscribeCalls: Array<{ gid: string; after?: number }> = [];
		let currentCursor = 3;

		const watch = runGroupWatch({
			client: {
				SubscribeGroupMessages: async (params: SubscribeGroupMessagesInput) => {
					subscribeCalls.push(params);
					return {
						stream: {
							async *[Symbol.asyncIterator]() {
								// no-op
							}
						},
						result: Promise.resolve({ subscribed: true }),
						abort: async () => undefined
					};
				}
			} as never,
			groupId: 'demo',
			getAfterCursor: () => currentCursor,
			fetchMessages: async (afterCursor) => {
				expect(afterCursor).toBe(3);
				return [
					{
						cursor: 8,
						gid: 'demo',
						at: 100,
						msg_64: 'catchup-8'
					}
				];
			},
			callbacks: {
				onConnecting: () => undefined,
				onWatching: () => undefined,
				onMessages: async (messages) => {
					const last = messages[messages.length - 1];
					if (last) {
						currentCursor = last.cursor;
					}
				}
			}
		});

		await watch.task;

		expect(subscribeCalls).toEqual([{ gid: 'demo', after: 8 }]);
	});

	test('preserves the fetch subscribe seam when the stream starts at the current cursor boundary', async () => {
		const seen: string[] = [];

		const watch = runGroupWatch({
			client: {
				SubscribeGroupMessages: async () => ({
					stream: {
						async *[Symbol.asyncIterator]() {
							yield {
								cursor: 4,
								gid: 'demo',
								at: 101,
								msg_64: 'replayed-boundary'
							};
							yield {
								cursor: 5,
								gid: 'demo',
								at: 102,
								msg_64: 'live-5'
							};
						}
					},
					result: Promise.resolve({ subscribed: true }),
					abort: async () => undefined
				})
			} as never,
			groupId: 'demo',
			getAfterCursor: () => 3,
			fetchMessages: async () => [
				{
					cursor: 4,
					gid: 'demo',
					at: 100,
					msg_64: 'catchup-4'
				}
			],
			callbacks: {
				onConnecting: () => {
					seen.push('connecting');
				},
				onWatching: () => {
					seen.push('watching');
				},
				onMessages: async (messages) => {
					seen.push(`messages:${messages.map((message) => message.cursor).join(',')}`);
				}
			}
		});

		await watch.task;

		expect(seen).toEqual(['connecting', 'messages:4', 'watching', 'messages:4', 'messages:5']);
	});

	test('forwards abort to the active subscription', async () => {
		const aborted: string[] = [];
		let releaseStream: (() => void) | undefined;

		const watch = runGroupWatch({
			client: {
				SubscribeGroupMessages: async () => ({
					stream: {
						async *[Symbol.asyncIterator]() {
							await new Promise<void>((resolve) => {
								releaseStream = resolve;
							});
						}
					},
					result: Promise.resolve({ subscribed: true }),
					abort: async (reason?: string) => {
						aborted.push(reason ?? '');
						releaseStream?.();
					}
				})
			} as never,
			groupId: 'demo',
			getAfterCursor: () => 0,
			fetchMessages: async () => [],
			callbacks: {
				onConnecting: () => undefined,
				onWatching: () => undefined,
				onMessages: async () => undefined
			}
		});

		await waitForCondition(() => releaseStream !== undefined);
		await watch.abort('user requested stop');
		await watch.task;

		expect(aborted).toEqual(['user requested stop']);
	});

	test('treats an intentional stream abort as a clean shutdown', async () => {
		let releaseStream: (() => void) | undefined;

		const watch = runGroupWatch({
			client: {
				SubscribeGroupMessages: async () => ({
					stream: {
						async *[Symbol.asyncIterator]() {
							await new Promise<void>((resolve) => {
								releaseStream = resolve;
							});

							throw new Error('Open stream aborted: user requested stop');
						}
					},
					result: Promise.resolve({ subscribed: true }),
					abort: async () => {
						releaseStream?.();
					}
				})
			} as never,
			groupId: 'demo',
			getAfterCursor: () => 0,
			fetchMessages: async () => [],
			callbacks: {
				onConnecting: () => undefined,
				onWatching: () => undefined,
				onMessages: async () => undefined
			}
		});

		await waitForCondition(() => releaseStream !== undefined);
		await watch.abort('user requested stop');

		await expect(watch.task).resolves.toBeUndefined();
	});

	test('keeps unexpected stream failures fatal', async () => {
		const watch = runGroupWatch({
			client: {
				SubscribeGroupMessages: async () => ({
					stream: {
						async *[Symbol.asyncIterator]() {
							throw new Error('relay disconnected');
						}
					},
					result: Promise.resolve({ subscribed: true }),
					abort: async () => undefined
				})
			} as never,
			groupId: 'demo',
			getAfterCursor: () => 0,
			fetchMessages: async () => [],
			callbacks: {
				onConnecting: () => undefined,
				onWatching: () => undefined,
				onMessages: async () => undefined
			}
		});

		await expect(watch.task).rejects.toThrow('relay disconnected');
	});
});
