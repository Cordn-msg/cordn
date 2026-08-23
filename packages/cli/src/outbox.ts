import { mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface OutboxSender {
  sendMessage(groupAlias: string, message: string): Promise<{ cursor: number }>;
}

export async function processOutbox(
  outboxDir: string,
  sender: OutboxSender,
  options: {
    defaultGroupAlias?: string;
    persist?: () => Promise<void>;
    onSent?: (name: string, cursor: number) => void;
  } = {},
): Promise<void> {
  await mkdir(outboxDir, { recursive: true, mode: 0o700 });
  const entries = (await readdir(outboxDir))
    .filter((name) => name.endsWith(".json"))
    .sort();

  for (const name of entries) {
    const queuedPath = join(outboxDir, name);
    const processingPath = `${queuedPath}.processing`;
    try {
      await rename(queuedPath, processingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    try {
      const job = JSON.parse(await readFile(processingPath, "utf8")) as {
        groupAlias?: string;
        message?: string;
      };
      const groupAlias = job.groupAlias?.trim() || options.defaultGroupAlias;
      const message = job.message?.trim();
      if (!groupAlias || !message) throw new Error("invalid outbox job");

      const stored = await sender.sendMessage(groupAlias, message);
      await options.persist?.();
      await unlink(processingPath);
      options.onSent?.(name, stored.cursor);
    } catch (error) {
      await rename(processingPath, queuedPath).catch(() => undefined);
      throw error;
    }
  }
}
