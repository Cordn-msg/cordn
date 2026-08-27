import { stdout as output } from "node:process";

import { CliSession, type KeyPackageSummary } from "./session.ts";
import type { CordnGroupMetadata } from "./groupMetadata.ts";
import { findImetaTag } from "./utils/mediaMessages.ts";

export const ansi = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
} as const;

function supportsColor(): boolean {
  return Boolean(output.isTTY && process.env.NO_COLOR === undefined);
}

export function colorize(text: string, ...codes: string[]): string {
  if (!supportsColor() || codes.length === 0) {
    return text;
  }

  return `${codes.join("")}${text}${ansi.reset}`;
}

export function formatList(values: string[]): string {
  return values.length === 0 ? "(none)" : values.join("\n");
}

function trimSenderLabel(sender: string): string {
  return sender.length <= 6 ? sender : sender.slice(0, 6);
}

export function formatCredentialLabel(sender: string): string {
  const trimmed = trimSenderLabel(sender);
  const red = Number.parseInt(trimmed.slice(0, 2), 16);
  const green = Number.parseInt(trimmed.slice(2, 4), 16);
  const blue = Number.parseInt(trimmed.slice(4, 6), 16);
  return colorize(trimmed, `\u001b[38;2;${red};${green};${blue}m`);
}

export function formatFullCredentialLabel(sender: string): string {
  const red = Number.parseInt(sender.slice(0, 2), 16);
  const green = Number.parseInt(sender.slice(2, 4), 16);
  const blue = Number.parseInt(sender.slice(4, 6), 16);
  return colorize(sender, `\u001b[38;2;${red};${green};${blue}m`);
}

export function formatCursor(cursor: number): string {
  return colorize(`[${cursor}]`, ansi.dim);
}

export function formatKeyPackageRef(ref: string): string {
  return colorize(ref, ansi.dim);
}

export function formatTimestamp(value: number | string): string {
  return colorize(String(value), ansi.dim);
}

export function formatGroupAlias(alias: string): string {
  return colorize(alias, ansi.cyan);
}

export function formatPromptGroupLabel(
  session: CliSession,
  groupAlias: string,
): string {
  const group = session.getGroup(groupAlias);
  const icon = group.metadata?.icon ? `${group.metadata.icon} ` : "";
  const name = group.metadata?.name
    ? ` ${colorize(group.metadata.name, ansi.bold)}`
    : "";

  return `${icon}${formatGroupAlias(groupAlias)}${name}`;
}

export function formatWelcomeKeyPackageReference(
  keyPackageReference: string,
): string {
  return colorize(keyPackageReference, ansi.magenta);
}

export function formatStatusValue(value: string | number): string {
  return colorize(String(value), ansi.bold);
}

export function formatGroupMetadata(metadata?: CordnGroupMetadata): string {
  if (!metadata) {
    return colorize("(no shared metadata)", ansi.dim);
  }

  const parts = [
    `name=${colorize(metadata.name, ansi.bold)}`,
    metadata.description
      ? `description=${colorize(metadata.description, ansi.dim)}`
      : undefined,
    metadata.icon ? `icon=${metadata.icon}` : undefined,
    metadata.imageUrl
      ? `image=${colorize(metadata.imageUrl, ansi.dim)}`
      : undefined,
    metadata.adminPubkeys && metadata.adminPubkeys.length > 0
      ? `admins=${metadata.adminPubkeys.length}`
      : undefined,
  ].filter(Boolean);

  return parts.join(" ");
}

export function formatKeyPackageSummary(summary: KeyPackageSummary): string {
  const parts = [
    summary.alias ? `alias=${formatGroupAlias(summary.alias)}` : undefined,
    `owner=${formatFullCredentialLabel(summary.stablePubkey)}`,
    `ref=${formatKeyPackageRef(summary.keyPackageRef)}`,
    summary.isLastResort === undefined
      ? undefined
      : `lastResort=${summary.isLastResort ? colorize("yes", ansi.green) : colorize("no", ansi.yellow)}`,
    summary.publishedAt === undefined
      ? `published=${colorize("no", ansi.yellow)}`
      : `published=${formatTimestamp(summary.publishedAt)}`,
    summary.consumed === undefined
      ? undefined
      : `consumed=${summary.consumed ? colorize("yes", ansi.green) : colorize("no", ansi.yellow)}`,
    `groupMetadataSupport=${summary.supportsGroupMetadata ? colorize("yes", ansi.green) : colorize("no", ansi.yellow)}`,
  ].filter(Boolean);

  return parts.join(" ");
}

export function formatGroupDetails(
  session: CliSession,
  groupAlias: string,
): string {
  const group = session.getGroup(groupAlias);
  return [
    `alias=${formatGroupAlias(group.alias)}`,
    `groupId=${session.deriveGroupId(group.state)}`,
    `coordinator=${formatFullCredentialLabel(group.coordinatorKey)}`,
    `cursor=${colorize(String(group.lastCursor), ansi.bold)}`,
    `messages=${colorize(String(group.messages.length), ansi.bold)}`,
    `sharedMetadata=${formatGroupMetadata(group.metadata)}`,
  ].join("\n");
}

export function formatChatLine(
  direction: "inbound" | "outbound",
  cursor: number,
  sender: string,
  content: string,
): string {
  const credential = formatCredentialLabel(sender);
  const label =
    direction === "outbound"
      ? `${colorize("you", ansi.green)}/${credential}`
      : credential;
  return `${formatCursor(cursor)} ${label}: ${content}`;
}

export function formatChatHistory(
  session: CliSession,
  groupAlias: string,
): string {
  return formatList(
    session.listMessages(groupAlias).map((message) => {
      const ref = findImetaTag(message.tags);
      const marker = ref
        ? `${colorize("[media]", ansi.cyan)} ${ref.filename} `
        : "";
      return formatChatLine(
        message.direction,
        message.cursor,
        message.sender,
        marker + message.content,
      );
    }),
  );
}

export function formatSyncResult(
  session: CliSession,
  groupAlias: string,
  _messages: Awaited<ReturnType<CliSession["syncGroup"]>>,
): string {
  return formatChatHistory(session, groupAlias);
}

export const REPL_COMMAND_HELP = [
  { names: ["help"], usage: "help" },
  { names: ["status"], usage: "status" },
  { names: ["whoami"], usage: "whoami    (prints the private identity key)" },
  {
    names: ["gen-kp"],
    usage:
      "gen-kp [alias] [--coordinator <pubkey>] [--last-resort] [--local-only]",
  },
  {
    names: ["publish-kp"],
    usage: "publish-kp <alias> [--coordinator <pubkey>]",
  },
  { names: ["key-packages", "kps"], usage: "key-packages | kps" },
  {
    names: ["delete-kp"],
    usage:
      "delete-kp <aliasOrKeyPackageRef> [--local-only] [--coordinator <pubkey>]",
  },
  {
    names: ["available-kps"],
    usage: "available-kps [--coordinator <pubkey>]",
  },
  {
    names: ["create-group"],
    usage:
      "create-group <alias> [keyPackageAlias] [--coordinator <pubkey>] [--name <value>] [--description <value>] [--icon <value>] [--image-url <value>] [--admin <hex>]... [--watch]",
  },
  {
    names: ["update-group-metadata"],
    usage:
      "update-group-metadata <groupAlias> --name <value> [--description <value>] [--icon <value>] [--image-url <value>] [--admin <hex>]...",
  },
  {
    names: ["set-metadata"],
    usage:
      "set-metadata <groupAlias> --name <value> [--description <value>] [--icon <value>] [--image-url <value>] [--admin <hex>]...",
  },
  { names: ["groups"], usage: "groups" },
  { names: ["group-info"], usage: "group-info [groupAlias]" },
  { names: ["group"], usage: "group <groupAlias> [--watch]" },
  { names: ["use"], usage: "use <groupAlias> [--watch]" },
  {
    names: ["leave"],
    usage: "leave    (clear selection; does not change group membership)",
  },
  { names: ["unwatch"], usage: "unwatch <groupAlias>" },
  {
    names: ["add-member"],
    usage: "add-member <groupAlias> <stablePubkeyOrKeyPackageRef>",
  },
  {
    names: ["remove-member"],
    usage: "remove-member <groupAlias> <stablePubkey>",
  },
  {
    names: ["fetch-welcomes"],
    usage: "fetch-welcomes [--coordinator <pubkey>]",
  },
  { names: ["welcomes"], usage: "welcomes" },
  {
    names: ["accept-welcome"],
    usage:
      "accept-welcome <welcomeIdOrKeyPackageReference> [groupAlias] [--coordinator <pubkey>] [--watch]",
  },
  {
    names: ["fetch-join-requests"],
    usage: "fetch-join-requests [groupAlias]",
  },
  {
    names: ["request-join"],
    usage: "request-join <gid> [keyPackageAlias] [--coordinator <pubkey>]",
  },
  { names: ["send"], usage: "send <message...>    (uses selected group)" },
  { names: ["send-to"], usage: "send-to <groupAlias> <message...>" },
  {
    names: ["send-media"],
    usage:
      "send-media <filePath> [caption...]   (uses selected group; requires --media-dir)",
  },
  {
    names: ["save-media"],
    usage:
      "save-media [groupAlias] <cursor> [destDir]   (decrypts media to destDir, default .)",
  },
  { names: ["sync"], usage: "sync [groupAlias]" },
  { names: ["sync-all"], usage: "sync-all" },
  { names: ["watch-all"], usage: "watch-all" },
  { names: ["messages"], usage: "messages [groupAlias]" },
  { names: ["issues"], usage: "issues [groupAlias]" },
  { names: ["exit", "quit"], usage: "exit | quit" },
] as const;

export function printHelp(): void {
  output.write(
    [
      "Commands:",
      ...REPL_COMMAND_HELP.map(({ usage }) => `  ${usage}`),
      "",
      "Key package notes:",
      "  gen-kp creates and publishes immediately unless --local-only is used.",
      "  publish-kp publishes a previously local-only key package.",
      "  --coordinator targets a coordinator other than the session default.",
      "",
      "Selected-group shortcuts:",
      "  <Enter> on an empty line => sync",
      "  plain text without a command => send",
      "",
      "More documentation:",
      "  Exit the REPL, then run: cordn docs commands",
      "",
    ].join("\n"),
  );
}
