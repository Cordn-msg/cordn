import type { Writable } from "node:stream";

import { CliSession } from "./session.ts";
import type { CordnGroupMetadata } from "./groupMetadata.ts";
import {
  ansi,
  colorize,
  formatChatHistory,
  formatCursor,
  formatFullCredentialLabel,
  formatGroupAlias,
  formatGroupDetails,
  formatGroupMetadata,
  formatKeyPackageRef,
  formatKeyPackageSummary,
  formatList,
  formatStatusValue,
  formatSyncResult,
  formatWelcomeKeyPackageReference,
  printHelp,
} from "./replFormat.ts";
import { CliUsageError, UnknownCommandError } from "./sessionErrors.ts";

export const knownCommands = new Set([
  "help",
  "status",
  "whoami",
  "gen-kp",
  "key-packages",
  "delete-kp",
  "available-kps",
  "create-group",
  "groups",
  "group-info",
  "group",
  "use",
  "leave",
  "unwatch",
  "add-member",
  "fetch-welcomes",
  "welcomes",
  "accept-welcome",
  "send",
  "send-to",
  "sync",
  "sync-all",
  "watch-all",
  "messages",
  "issues",
  "exit",
  "quit",
]);

export interface ReplCommandContext {
  session: CliSession;
  output: Writable;
  selectedGroupAlias?: string;
}

export interface ReplCommandResult {
  selectedGroupAlias?: string;
  shouldExit?: boolean;
}

function formatGeneratedKeyPackageMessage(params: {
  alias: string;
  keyPackageRef: string;
  coordinatorKey?: string;
  publishedAt?: number;
}): string {
  const publishState =
    params.publishedAt === undefined
      ? " localOnly=yes"
      : params.coordinatorKey
        ? ` publishedTo=${formatFullCredentialLabel(params.coordinatorKey)}`
        : " publishedTo=default-coordinator";

  return `${colorize("generated", ansi.green)} alias=${params.alias} ref=${colorize(params.keyPackageRef, ansi.dim)}${publishState}`;
}

export function tokenizeInput(line: string): string[] {
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

export function parseCreateGroupArgs(args: string[]): {
  alias: string;
  keyPackageAlias?: string;
  metadata?: CordnGroupMetadata;
  coordinatorKey?: string;
  watch: boolean;
} {
  const alias = args[0];

  if (!alias) {
    throw new CliUsageError(
      "Usage: create-group <alias> [keyPackageAlias] [--coordinator <pubkey>] [--name <value>] [--description <value>] [--icon <value>] [--image-url <value>] [--admin <hex>]...",
    );
  }

  let index = 1;
  let keyPackageAlias: string | undefined;
  let coordinatorKey: string | undefined;
  let watch = false;

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
      throw new CliUsageError(`Unexpected create-group argument: ${flag}`);
    }

    switch (flag) {
      case "--watch":
        watch = true;
        index += 1;
        break;
      case "--coordinator":
        if (!value) throw new CliUsageError("Missing value for --coordinator");
        coordinatorKey = value;
        index += 2;
        break;
      case "--name":
        if (!value) throw new CliUsageError("Missing value for --name");
        metadata.name = value;
        metadataProvided = true;
        index += 2;
        break;
      case "--description":
        if (!value) throw new CliUsageError("Missing value for --description");
        metadata.description = value;
        metadataProvided = true;
        index += 2;
        break;
      case "--icon":
        if (!value) throw new CliUsageError("Missing value for --icon");
        metadata.icon = value;
        metadataProvided = true;
        index += 2;
        break;
      case "--image-url":
        if (!value) throw new CliUsageError("Missing value for --image-url");
        metadata.imageUrl = value;
        metadataProvided = true;
        index += 2;
        break;
      case "--admin":
        if (!value) throw new CliUsageError("Missing value for --admin");
        metadata.adminPubkeys = [...(metadata.adminPubkeys ?? []), value];
        metadataProvided = true;
        index += 2;
        break;
      default:
        throw new CliUsageError(`Unknown create-group option: ${flag}`);
    }
  }

  if (metadataProvided && metadata.name === "") {
    throw new CliUsageError("create-group metadata requires --name for v1");
  }

  return {
    alias,
    keyPackageAlias,
    metadata: metadataProvided ? metadata : undefined,
    coordinatorKey,
    watch,
  };
}

function parseCoordinatorOption(args: string[]): string | undefined {
  const index = args.indexOf("--coordinator");
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value) {
    throw new CliUsageError("Missing value for --coordinator");
  }

  return value;
}

function getPositionalArgs(args: string[]): string[] {
  const positionalArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    switch (arg) {
      case "--coordinator":
      case "--name":
      case "--description":
      case "--icon":
      case "--image-url":
      case "--admin":
        index += 1;
        continue;
      case "--watch":
      case "--last-resort":
      case "--local-only":
        continue;
      default:
        if (!arg.startsWith("--")) {
          positionalArgs.push(arg);
        }
    }
  }

  return positionalArgs;
}

export async function executeReplCommand(
  command: string,
  args: string[],
  context: ReplCommandContext,
): Promise<ReplCommandResult> {
  const { session, output } = context;
  let { selectedGroupAlias } = context;
  const positionalArgs = getPositionalArgs(args);

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
      const coordinatorKey = parseCoordinatorOption(args);
      const result = await session.generateKeyPackage(positionalArgs[0], {
        localOnly: args.includes("--local-only"),
        lastResort: args.includes("--last-resort"),
        coordinatorKey,
      });
      output.write(
        `${formatGeneratedKeyPackageMessage({
          alias: result.alias,
          keyPackageRef: result.keyPackageRef,
          coordinatorKey,
          publishedAt: result.publishedAt,
        })}\n`,
      );
      break;
    }
    case "kps":
    case "key-packages": {
      output.write(
        `${formatList(session.listKeyPackageSummaries().map((entry) => formatKeyPackageSummary(entry)))}\n`,
      );
      break;
    }
    case "delete-kp": {
      if (!args[0]) {
        throw new CliUsageError(
          "Usage: delete-kp <aliasOrKeyPackageRef> [--local-only] [--coordinator <pubkey>]",
        );
      }
      const result = await session.deleteKeyPackage(args[0], {
        localOnly: args.includes("--local-only"),
        coordinatorKey: parseCoordinatorOption(args),
      });
      output.write(
        `${colorize("deleted", ansi.green)} ${colorize(result.keyPackageRef, ansi.dim)}${result.removedLocal ? "" : " (remote only)"}\n`,
      );
      break;
    }
    case "available-kps": {
      const keyPackages = await session.listAvailableKeyPackageSummaries(
        parseCoordinatorOption(args),
      );
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
        coordinatorKey: parsed.coordinatorKey,
      });
      if (parsed.watch) {
        await session.watchGroup(group.alias);
      }
      selectedGroupAlias = group.alias;
      output.write(
        `${colorize("created group", ansi.green)} ${colorize(group.alias, ansi.cyan)} ${formatGroupMetadata(group.metadata)}\n`,
      );
      break;
    }
    case "groups": {
      output.write(
        `${formatList(session.listGroupEntries().map((group) => `${formatGroupAlias(group.alias)} cursor=${colorize(String(group.lastCursor), ansi.bold)} messages=${colorize(String(group.messageCount), ansi.bold)} watching=${group.watchStatus === "idle" ? colorize("no", ansi.yellow) : colorize(group.watchStatus, group.watchStatus === "errored" ? ansi.red : ansi.green)}${group.watchStatus === "errored" && group.error ? ` error=${colorize(group.error, ansi.red)}` : ""} ${formatGroupMetadata(group.metadata)}`))}\n`,
      );
      break;
    }
    case "group-info": {
      const alias = args[0] ?? selectedGroupAlias;
      if (!alias) throw new CliUsageError("Usage: group-info [groupAlias]");
      output.write(`${formatGroupDetails(session, alias)}\n`);
      break;
    }
    case "group":
    case "use": {
      if (!args[0]) throw new CliUsageError("Usage: use <groupAlias>");
      const group = session.getGroup(args[0]);
      if (args.includes("--watch")) {
        await session.watchGroup(args[0]);
      }
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
    case "unwatch": {
      if (!args[0]) throw new CliUsageError("Usage: unwatch <groupAlias>");
      await session.unwatchGroup(args[0]);
      output.write(
        `${colorize("unwatched", ansi.yellow)} ${colorize(args[0], ansi.cyan)}\n`,
      );
      break;
    }
    case "add-member": {
      if (!args[0] || !args[1]) {
        throw new CliUsageError(
          "Usage: add-member <groupAlias> <stablePubkeyOrKeyPackageRef>",
        );
      }
      const result = await session.addMember(args[0], args[1]);
      await session.syncGroup(args[0]);
      output.write(
        `${colorize("stored welcome", ansi.green)} ${colorize(result.keyPackageReference, ansi.dim)}\n`,
      );
      break;
    }
    case "fetch-welcomes": {
      const welcomes = await session.fetchWelcomes(
        parseCoordinatorOption(args),
      );
      output.write(
        `${formatList(welcomes.map((welcome) => `${formatWelcomeKeyPackageReference(welcome.kp_ref)} keyPackageRef=${formatKeyPackageRef(welcome.kp_ref)}`))}\n`,
      );
      break;
    }
    case "welcomes": {
      output.write(
        `${formatList(session.listWelcomes().map((welcome) => `${formatWelcomeKeyPackageReference(welcome.kp_ref)} keyPackageRef=${formatKeyPackageRef(welcome.kp_ref)}`))}\n`,
      );
      break;
    }
    case "accept-welcome": {
      if (!positionalArgs[0]) {
        throw new CliUsageError(
          "Usage: accept-welcome <keyPackageReference> [groupAlias] [--coordinator <pubkey>] [--watch]",
        );
      }
      const group = await session.acceptWelcome(
        positionalArgs[0],
        positionalArgs[1],
        parseCoordinatorOption(args),
      );
      if (args.includes("--watch")) {
        await session.watchGroup(group.alias);
      }
      selectedGroupAlias = group.alias;
      output.write(
        `${colorize("accepted welcome into", ansi.green)} ${colorize(group.alias, ansi.cyan)} ${formatGroupMetadata(group.metadata)}\n`,
      );
      break;
    }
    case "send": {
      if (!selectedGroupAlias) {
        throw new CliUsageError(
          "No selected group. Use `use <groupAlias>` first.",
        );
      }
      if (args.length === 0)
        throw new CliUsageError("Usage: send <message...>");
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
      if (!args[0] || args.length < 2) {
        throw new CliUsageError("Usage: send-to <groupAlias> <message...>");
      }
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
      if (!alias) throw new CliUsageError("Usage: sync <groupAlias>");
      const messages = await session.syncGroup(alias);
      output.write(`${formatSyncResult(session, alias, messages)}\n`);
      break;
    }
    case "sync-all": {
      const result = await session.syncAll();
      output.write(`${JSON.stringify(result, null, 2)}\n`);
      break;
    }
    case "watch-all": {
      await session.watchAllGroups();
      output.write(`${colorize("watching", ansi.green)} all groups\n`);
      break;
    }
    case "messages": {
      const alias = args[0] ?? selectedGroupAlias;
      if (!alias) throw new CliUsageError("Usage: messages <groupAlias>");
      await session.syncGroup(alias);
      output.write(`${formatChatHistory(session, alias)}\n`);
      break;
    }
    case "issues": {
      const alias = args[0] ?? selectedGroupAlias;
      if (!alias) throw new CliUsageError("Usage: issues <groupAlias>");
      output.write(
        `${formatList(session.listSyncIssues(alias).map((issue) => `${formatCursor(issue.cursor)} ${colorize(issue.detail, ansi.yellow)}`))}\n`,
      );
      break;
    }
    case "exit":
    case "quit": {
      return {
        selectedGroupAlias,
        shouldExit: true,
      };
    }
    default: {
      throw new UnknownCommandError(command);
    }
  }

  return { selectedGroupAlias };
}
