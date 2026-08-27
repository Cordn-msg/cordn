import { mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const PROCESSING_SUFFIX = ".processing";
const INVALID_SUFFIX = ".invalid";

interface OutboxSender {
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
    .filter(
      (name) =>
        name.endsWith(".json") || name.endsWith(`.json${PROCESSING_SUFFIX}`),
    )
    .sort((left, right) => {
      const leftBase = left.endsWith(PROCESSING_SUFFIX)
        ? left.slice(0, -PROCESSING_SUFFIX.length)
        : left;
      const rightBase = right.endsWith(PROCESSING_SUFFIX)
        ? right.slice(0, -PROCESSING_SUFFIX.length)
        : right;
      const baseOrder =
        leftBase < rightBase ? -1 : leftBase > rightBase ? 1 : 0;
      return (
        baseOrder ||
        Number(right.endsWith(PROCESSING_SUFFIX)) -
          Number(left.endsWith(PROCESSING_SUFFIX))
      );
    });

  for (const name of entries) {
    // A `.processing` leftover means a previous run crashed mid-job; adopt it
    // instead of orphaning it behind the `.json` filter forever.
    const base = name.endsWith(PROCESSING_SUFFIX)
      ? name.slice(0, -PROCESSING_SUFFIX.length)
      : name;
    const queuedPath = join(outboxDir, base);
    const processingPath = `${queuedPath}${PROCESSING_SUFFIX}`;

    if (base === name) {
      try {
        await rename(queuedPath, processingPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }

    let job: unknown;
    try {
      job = JSON.parse(await readFile(processingPath, "utf8"));
    } catch {
      await rename(processingPath, `${queuedPath}${INVALID_SUFFIX}`);
      continue;
    }
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      await rename(processingPath, `${queuedPath}${INVALID_SUFFIX}`);
      continue;
    }
    const candidate = job as Record<string, unknown>;
    if (
      candidate.groupAlias !== undefined &&
      typeof candidate.groupAlias !== "string"
    ) {
      await rename(processingPath, `${queuedPath}${INVALID_SUFFIX}`);
      continue;
    }
    const groupAlias =
      candidate.groupAlias?.trim() || options.defaultGroupAlias?.trim();
    const message =
      typeof candidate.message === "string" && candidate.message.trim()
        ? candidate.message
        : undefined;
    if (!groupAlias || !message) {
      await rename(processingPath, `${queuedPath}${INVALID_SUFFIX}`);
      continue;
    }

    try {
      const stored = await sender.sendMessage(groupAlias, message);
      await options.persist?.();
      await unlink(processingPath);
      options.onSent?.(base, stored.cursor);
    } catch (error) {
      await rename(processingPath, queuedPath).catch(() => undefined);
      throw error;
    }
  }
}
