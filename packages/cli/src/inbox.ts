import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { StoredMessage } from "./sessionState.ts";

export async function enqueueInboundMessages(
  inboxDir: string,
  groupAlias: string,
  messages: StoredMessage[],
): Promise<void> {
  await mkdir(inboxDir, { recursive: true, mode: 0o700 });
  for (const message of messages.filter(
    (item) => item.direction === "inbound",
  )) {
    const name = `${String(message.cursor).padStart(16, "0")}-${randomUUID()}.json`;
    const finalPath = join(inboxDir, name);
    const temporaryPath = `${finalPath}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        groupAlias,
        cursor: message.cursor,
        createdAt: message.createdAt,
        sender: message.sender,
        id: message.id,
        content: message.content,
      })}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryPath, finalPath);
  }
}
