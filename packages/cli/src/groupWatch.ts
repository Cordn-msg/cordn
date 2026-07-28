import type { GroupMessage } from "@cordn/core";
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
  let expectedAbortReason: string | undefined;
  const task = (async () => {
    callbacks.onConnecting();

    const catchup = await fetchMessages(getAfterCursor());
    await callbacks.onMessages(catchup);

    const afterCursor = getAfterCursor();
    const subscription = await client.SubscribeManyGroupMessages({
      groups: [
        {
          gid: groupId,
          after: afterCursor > 0 ? afterCursor : undefined,
        },
      ],
    });
    void subscription.result.catch(() => undefined);

    abort = async (reason?: string) => {
      expectedAbortReason = reason;
      await subscription.abort(reason).catch(() => undefined);
    };

    callbacks.onWatching();

    try {
      for await (const message of subscription.stream) {
        await callbacks.onMessages([message]);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (
        expectedAbortReason !== undefined &&
        detail === `Open stream aborted: ${expectedAbortReason}`
      ) {
        return;
      }

      throw error;
    }
  })();

  return {
    abort: async (reason?: string) => abort(reason),
    task,
  };
}
