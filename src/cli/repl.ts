import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { CliSession, type KeyPackageSummary } from "./session.ts";
import type { CordnGroupMetadata } from "./groupMetadata.ts";

const ansi = {
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

function colorize(text: string, ...codes: string[]): string {
  if (!supportsColor() || codes.length === 0) {
    return text;
  }

  return `${codes.join("")}${text}${ansi.reset}`;
}

function formatList(values: string[]): string {
  return values.length === 0 ? "(none)" : values.join("\n");
}

function printHelp(): void {
  output.write(
    [
      "Commands:",
      "  help",
      "  status",
      "  whoami",
      "  gen-kp [alias]",
      "  key-packages",
      "  publish-kp <alias>",
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

function trimSenderLabel(sender: string): string {
  return sender.length <= 6 ? sender : sender.slice(0, 6);
}

function formatCredentialLabel(sender: string): string {
  const trimmed = trimSenderLabel(sender);
  const red = Number.parseInt(trimmed.slice(0, 2), 16);
  const green = Number.parseInt(trimmed.slice(2, 4), 16);
  const blue = Number.parseInt(trimmed.slice(4, 6), 16);
  return colorize(trimmed, `\u001b[38;2;${red};${green};${blue}m`);
}

function formatFullCredentialLabel(sender: string): string {
  const red = Number.parseInt(sender.slice(0, 2), 16);
  const green = Number.parseInt(sender.slice(2, 4), 16);
  const blue = Number.parseInt(sender.slice(4, 6), 16);
  return colorize(sender, `\u001b[38;2;${red};${green};${blue}m`);
}

function formatCursor(cursor: number): string {
  return colorize(`[${cursor}]`, ansi.dim);
}

function formatKeyPackageRef(ref: string): string {
  return colorize(ref, ansi.dim);
}

function formatTimestamp(value: number | string): string {
  return colorize(String(value), ansi.dim);
}

function formatGroupAlias(alias: string): string {
  return colorize(alias, ansi.cyan);
}

function formatPromptGroupLabel(
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

function formatWelcomeKeyPackageReference(keyPackageReference: string): string {
  return colorize(keyPackageReference, ansi.magenta);
}

function formatStatusValue(value: string | number): string {
  return colorize(String(value), ansi.bold);
}

function tokenizeInput(line: string): string[] {
  const tokens = line.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) ?? [];

  return tokens.map((token) => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1).replace(/\\(["'\\])/g, "$1");
    }

    return token;
  });
}

function formatGroupMetadata(metadata?: CordnGroupMetadata): string {
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

function formatKeyPackageSummary(summary: KeyPackageSummary): string {
  const parts = [
    summary.alias ? `alias=${formatGroupAlias(summary.alias)}` : undefined,
    `owner=${formatFullCredentialLabel(summary.stablePubkey)}`,
    `ref=${formatKeyPackageRef(summary.keyPackageRef)}`,
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

function formatGroupDetails(session: CliSession, groupAlias: string): string {
  const group = session.getGroup(groupAlias);
  return [
    `alias=${formatGroupAlias(group.alias)}`,
    `cursor=${colorize(String(group.lastCursor), ansi.bold)}`,
    `messages=${colorize(String(group.messages.length), ansi.bold)}`,
    `sharedMetadata=${formatGroupMetadata(group.metadata)}`,
  ].join("\n");
}

function parseCreateGroupArgs(args: string[]): {
  alias: string;
  keyPackageAlias?: string;
  metadata?: CordnGroupMetadata;
} {
  const alias = args[0];

  if (!alias) {
    throw new Error(
      "Usage: create-group <alias> [keyPackageAlias] [--name <value>] [--description <value>] [--icon <value>] [--image-url <value>] [--admin <hex>]...",
    );
  }

  let index = 1;
  let keyPackageAlias: string | undefined;

  if (args[index] && !args[index]!.startsWith("--")) {
    keyPackageAlias = args[index];
    index += 1;
  }

  const metadata: CordnGroupMetadata = { name: "" };
  let metadataProvided = false;

  while (index < args.length) {
    const flag = args[index];
    const value = args[index + 1];

    if (!flag?.startsWith("--")) {
      throw new Error(`Unexpected create-group argument: ${flag}`);
    }

    switch (flag) {
      case "--name":
        if (!value) throw new Error("Missing value for --name");
        metadata.name = value;
        metadataProvided = true;
        index += 2;
        break;
      case "--description":
        if (!value) throw new Error("Missing value for --description");
        metadata.description = value;
        metadataProvided = true;
        index += 2;
        break;
      case "--icon":
        if (!value) throw new Error("Missing value for --icon");
        metadata.icon = value;
        metadataProvided = true;
        index += 2;
        break;
      case "--image-url":
        if (!value) throw new Error("Missing value for --image-url");
        metadata.imageUrl = value;
        metadataProvided = true;
        index += 2;
        break;
      case "--admin":
        if (!value) throw new Error("Missing value for --admin");
        metadata.adminPubkeys = [...(metadata.adminPubkeys ?? []), value];
        metadataProvided = true;
        index += 2;
        break;
      default:
        throw new Error(`Unknown create-group option: ${flag}`);
    }
  }

  if (metadataProvided && metadata.name === "") {
    throw new Error("create-group metadata requires --name for v1");
  }

  return {
    alias,
    keyPackageAlias,
    metadata: metadataProvided ? metadata : undefined,
  };
}

function formatChatLine(
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

function formatChatHistory(session: CliSession, groupAlias: string): string {
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

function formatSyncResult(
  session: CliSession,
  groupAlias: string,
  messages: Awaited<ReturnType<CliSession["syncGroup"]>>,
): string {
  if (messages.length > 0) {
    return formatList(
      messages.map((message) =>
        formatChatLine(
          message.direction,
          message.cursor,
          message.sender,
          message.plaintext,
        ),
      ),
    );
  }

  return formatChatHistory(session, groupAlias);
}

export async function startCliRepl(session: CliSession): Promise<void> {
  const rl = createInterface({ input, output });
  let selectedGroupAlias: string | undefined;

  printHelp();

  try {
    while (true) {
      const prompt = selectedGroupAlias
        ? `cordn:${formatPromptGroupLabel(session, selectedGroupAlias)}> `
        : "cordn> ";
      const line = (await rl.question(prompt)).trim();

      if (!line) {
        if (selectedGroupAlias) {
          try {
            const messages = await session.syncGroup(selectedGroupAlias);
            output.write(
              `${formatSyncResult(session, selectedGroupAlias, messages)}\n`,
            );
          } catch (error) {
            output.write(
              `${colorize(error instanceof Error ? error.message : String(error), ansi.red)}\n`,
            );
          }
        }
        continue;
      }

      const [rawCommand = "", ...args] = tokenizeInput(line);
      const command = rawCommand;
      const knownCommands = new Set([
        "help",
        "status",
        "whoami",
        "gen-kp",
        "key-packages",
        "publish-kp",
        "available-kps",
        "create-group",
        "groups",
        "group-info",
        "group",
        "use",
        "leave",
        "add-member",
        "fetch-welcomes",
        "welcomes",
        "accept-welcome",
        "send",
        "send-to",
        "sync",
        "sync-all",
        "messages",
        "issues",
        "exit",
        "quit",
      ]);

      if (selectedGroupAlias && !knownCommands.has(command)) {
        try {
          const stored = await session.sendMessage(selectedGroupAlias, line);
          output.write(`sent cursor=${stored.cursor}\n`);
        } catch (error) {
          output.write(
            `${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
        continue;
      }

      try {
        switch (command) {
          case "help": {
            printHelp();
            break;
          }
          case "status": {
            const status = session.getStatus();
            output.write(
              [
                `${colorize("stablePubkey", ansi.cyan)}: ${formatFullCredentialLabel(status.stablePubkey)}`,
                `${colorize("keyPackageCount", ansi.cyan)}: ${formatStatusValue(status.keyPackageCount)}`,
                `${colorize("welcomeCount", ansi.cyan)}: ${formatStatusValue(status.welcomeCount)}`,
                `${colorize("groupCount", ansi.cyan)}: ${formatStatusValue(status.groupCount)}`,
              ].join("\n") + "\n",
            );
            break;
          }
          case "whoami": {
            output.write(
              `stablePubkey: ${formatFullCredentialLabel(session.stablePubkey)}\nprivateKey: ${colorize(session.privateKey, ansi.dim)}\n`,
            );
            break;
          }
          case "gen-kp": {
            const result = await session.generateKeyPackage(args[0]);
            output.write(
              `${colorize("generated", ansi.green)} ${result.alias} (${colorize(result.keyPackageRef, ansi.dim)})\n`,
            );
            break;
          }
          case "key-packages": {
            output.write(
              `${formatList(session.listKeyPackageSummaries().map((entry) => formatKeyPackageSummary(entry)))}\n`,
            );
            break;
          }
          case "publish-kp": {
            if (!args[0]) throw new Error("Usage: publish-kp <alias>");
            const result = await session.publishKeyPackage(args[0]);
            output.write(
              `${colorize("published", ansi.green)} ${result.alias} at ${colorize(String(result.publishedAt), ansi.dim)}\n`,
            );
            break;
          }
          case "available-kps": {
            const keyPackages =
              await session.listAvailableKeyPackageSummaries();
            output.write(
              `${formatList(keyPackages.map((entry) => formatKeyPackageSummary(entry)))}\n`,
            );
            break;
          }
          case "create-group": {
            const parsed = parseCreateGroupArgs(args);
            const group = await session.createGroup(parsed.alias, {
              keyPackageAlias: parsed.keyPackageAlias,
              metadata: parsed.metadata,
            });
            selectedGroupAlias = group.alias;
            output.write(
              `${colorize("created group", ansi.green)} ${colorize(group.alias, ansi.cyan)} ${formatGroupMetadata(group.metadata)}\n`,
            );
            break;
          }
          case "groups": {
            output.write(
              `${formatList(session.listGroups().map((group) => `${formatGroupAlias(group.alias)} cursor=${colorize(String(group.lastCursor), ansi.bold)} messages=${colorize(String(group.messages.length), ansi.bold)} ${formatGroupMetadata(group.metadata)}`))}\n`,
            );
            break;
          }
          case "group-info": {
            const alias = args[0] ?? selectedGroupAlias;
            if (!alias) throw new Error("Usage: group-info [groupAlias]");
            output.write(`${formatGroupDetails(session, alias)}\n`);
            break;
          }
          case "group":
          case "use": {
            if (!args[0]) throw new Error("Usage: use <groupAlias>");
            const group = session.getGroup(args[0]);
            selectedGroupAlias = args[0];
            output.write(
              `${colorize("selected group", ansi.green)} ${colorize(selectedGroupAlias, ansi.cyan)} ${formatGroupMetadata(group.metadata)}\n`,
            );
            break;
          }
          case "leave": {
            selectedGroupAlias = undefined;
            output.write(`${colorize("left", ansi.yellow)} group context\n`);
            break;
          }
          case "add-member": {
            if (!args[0] || !args[1])
              throw new Error(
                "Usage: add-member <groupAlias> <stablePubkeyOrKeyPackageRef>",
              );
            const result = await session.addMember(args[0], args[1]);
            output.write(
              `${colorize("stored welcome", ansi.green)} ${colorize(result.keyPackageReference, ansi.dim)}\n`,
            );
            break;
          }
          case "fetch-welcomes": {
            const welcomes = await session.fetchWelcomes();
            output.write(
              `${formatList(welcomes.map((welcome) => `${formatWelcomeKeyPackageReference(welcome.keyPackageReference)} keyPackageRef=${formatKeyPackageRef(welcome.keyPackageReference)}`))}\n`,
            );
            break;
          }
          case "welcomes": {
            output.write(
              `${formatList(session.listWelcomes().map((welcome) => `${formatWelcomeKeyPackageReference(welcome.keyPackageReference)} keyPackageRef=${formatKeyPackageRef(welcome.keyPackageReference)}`))}\n`,
            );
            break;
          }
          case "accept-welcome": {
            if (!args[0])
              throw new Error(
                "Usage: accept-welcome <keyPackageReference> [groupAlias]",
              );
            const group = await session.acceptWelcome(args[0], args[1]);
            selectedGroupAlias = group.alias;
            output.write(
              `${colorize("accepted welcome into", ansi.green)} ${colorize(group.alias, ansi.cyan)} ${formatGroupMetadata(group.metadata)}\n`,
            );
            break;
          }
          case "send": {
            if (!selectedGroupAlias)
              throw new Error(
                "No selected group. Use `use <groupAlias>` first.",
              );
            if (args.length === 0) throw new Error("Usage: send <message...>");
            const stored = await session.sendMessage(
              selectedGroupAlias,
              args.join(" "),
            );
            output.write(
              `${colorize("sent", ansi.green)} cursor=${colorize(String(stored.cursor), ansi.bold)}\n`,
            );
            break;
          }
          case "send-to": {
            if (!args[0] || args.length < 2)
              throw new Error("Usage: send-to <groupAlias> <message...>");
            const stored = await session.sendMessage(
              args[0],
              args.slice(1).join(" "),
            );
            output.write(
              `${colorize("sent", ansi.green)} cursor=${colorize(String(stored.cursor), ansi.bold)}\n`,
            );
            break;
          }
          case "sync": {
            const alias = args[0] ?? selectedGroupAlias;
            if (!alias) throw new Error("Usage: sync <groupAlias>");
            const messages = await session.syncGroup(alias);
            output.write(`${formatSyncResult(session, alias, messages)}\n`);
            break;
          }
          case "sync-all": {
            const result = await session.syncAll();
            output.write(`${JSON.stringify(result, null, 2)}\n`);
            break;
          }
          case "messages": {
            const alias = args[0] ?? selectedGroupAlias;
            if (!alias) throw new Error("Usage: messages <groupAlias>");
            await session.syncGroup(alias);
            output.write(`${formatChatHistory(session, alias)}\n`);
            break;
          }
          case "issues": {
            const alias = args[0] ?? selectedGroupAlias;
            if (!alias) throw new Error("Usage: issues <groupAlias>");
            output.write(
              `${formatList(session.listSyncIssues(alias).map((issue) => `${formatCursor(issue.cursor)} ${colorize(issue.detail, ansi.yellow)}`))}\n`,
            );
            break;
          }
          case "exit":
          case "quit": {
            return;
          }
          default: {
            throw new Error(`Unknown command: ${command}`);
          }
        }
      } catch (error) {
        output.write(
          `${colorize(error instanceof Error ? error.message : String(error), ansi.red)}\n`,
        );
      }
    }
  } finally {
    rl.close();
  }
}
