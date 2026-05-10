import type { GroupMessage } from "../contracts/index.ts";
import type { coordinatorClient } from "./coordinatorClient.ts";

export interface GroupWatchCallbacks {
  onConnecting: () => void;
  onWatching: () => void;
  onMessages: (messages: GroupMessage[]) => Promise<void>;
}

export interface GroupWatchHandle {
  abort: (reason?: string) => Promise<void>;
  task: Promise<void>;
}

export function runGroupWatch(params: {
  client: coordinatorClient;
  groupId: string;
  getAfterCursor: () => number;
  fetchMessages: (afterCursor: number) => Promise<GroupMessage[]>;
  callbacks: GroupWatchCallbacks;
}): GroupWatchHandle {
  const { client, groupId, getAfterCursor, fetchMessages, callbacks } = params;

  let abort: (reason?: string) => Promise<void> = async () => undefined;
  const task = (async () => {
    callbacks.onConnecting();

    const catchup = await fetchMessages(getAfterCursor());
    await callbacks.onMessages(catchup);

    const afterCursor = getAfterCursor();
    const subscription = await client.SubscribeGroupMessages({
      groupId,
      afterCursor: afterCursor > 0 ? afterCursor : undefined,
    });
    void subscription.result.catch(() => undefined);

    abort = async (reason?: string) => {
      await subscription.abort(reason).catch(() => undefined);
    };

    callbacks.onWatching();

    for await (const message of subscription.stream) {
      await callbacks.onMessages([message]);
    }
  })();

  return {
    abort: async (reason?: string) => abort(reason),
    task,
  };
}
