import { stdout as output } from "node:process";

import { CliSession, type KeyPackageSummary } from "./session.ts";
import type { CordnGroupMetadata } from "./groupMetadata.ts";

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
    `cursor=${colorize(String(group.lastCursor), ansi.bold)}`,
    `messages=${colorize(String(group.messages.length), ansi.bold)}`,
    `sharedMetadata=${formatGroupMetadata(group.metadata)}`,
  ].join("\n");
}

export function formatChatLine(
  direction: "inbound" | "outbound",
  cursor: number,
  sender: string,
  plaintext: string,
): string {
  const credential = formatCredentialLabel(sender);
  const label =
    direction === "outbound"
      ? `${colorize("you", ansi.green)}/${credential}`
      : credential;
  return `${formatCursor(cursor)} ${label}: ${plaintext}`;
}

export function formatChatHistory(
  session: CliSession,
  groupAlias: string,
): string {
  return formatList(
    session
      .listMessages(groupAlias)
      .map((message) =>
        formatChatLine(
          message.direction,
          message.cursor,
          message.sender,
          message.plaintext,
        ),
      ),
  );
}

export function formatSyncResult(
  session: CliSession,
  groupAlias: string,
  _messages: Awaited<ReturnType<CliSession["syncGroup"]>>,
): string {
  return formatChatHistory(session, groupAlias);
}

export function printHelp(): void {
  output.write(
    [
      "Commands:",
      "  help",
      "  status",
      "  whoami",
      "  gen-kp [alias] [--last-resort] [--local-only]",
      "  key-packages | kps",
      "  delete-kp <aliasOrKeyPackageRef> [--local-only]",
      "  available-kps",
      "  create-group <alias> [keyPackageAlias] [--name <value>] [--description <value>] [--icon <value>] [--image-url <value>] [--admin <hex>]...",
      "  groups",
      "  group-info [groupAlias]",
      "  group <groupAlias>",
      "  use <groupAlias>",
      "  leave",
      "  add-member <groupAlias> <stablePubkeyOrKeyPackageRef>",
      "  fetch-welcomes",
      "  welcomes",
      "  accept-welcome <keyPackageReference> [groupAlias]",
      "  send <message...>    (uses selected group)",
      "  send-to <groupAlias> <message...>",
      "  sync [groupAlias]",
      "  sync-all",
      "  messages [groupAlias]",
      "  issues [groupAlias]",
      "  exit",
      "",
      "Selected-group shortcuts:",
      "  <Enter> on an empty line => sync",
      "  plain text without a command => send",
      "",
    ].join("\n"),
  );
}
