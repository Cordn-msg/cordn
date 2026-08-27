import { readFile } from "node:fs/promises";

const DOC_FILES = {
  quickstart: "QUICKSTART.md",
  commands: "COMMANDS.md",
  agent: "AGENT.md",
  daemon: "DAEMON.md",
  queues: "QUEUES.md",
  security: "SECURITY.md",
} as const;

export const CLI_DOC_TOPICS = Object.keys(DOC_FILES);

export async function readCliDoc(topic?: string): Promise<string> {
  const normalized = topic?.trim().toLowerCase();
  if (!normalized || normalized === "help" || normalized === "index") {
    return readFile(new URL("../docs/README.md", import.meta.url), "utf8");
  }

  const file = DOC_FILES[normalized as keyof typeof DOC_FILES];
  if (!file) {
    throw new Error(
      `unknown docs topic: ${topic}; available topics: ${CLI_DOC_TOPICS.join(", ")}`,
    );
  }

  return readFile(new URL(`../docs/${file}`, import.meta.url), "utf8");
}
