import type { Writable } from "node:stream";
import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

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
import { welcomeIdentifier } from "./sessionStore.ts";

export const knownCommands = new Set([
  "help",
  "status",
  "whoami",
  "gen-kp",
  "key-packages",
  "delete-kp",
  "available-kps",
  "create-group",
  "update-group-metadata",
  "set-metadata",
  "groups",
  "group-info",
  "group",
  "use",
  "leave",
  "unwatch",
  "add-member",
  "remove-member",
  "fetch-welcomes",
  "welcomes",
  "accept-welcome",
  "send",
  "send-to",
  "send-media",
  "save-media",
  "sync",
  "sync-all",
  "watch-all",
  "messages",
  "issues",
  "fetch-join-requests",
  "request-join",
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

function applyMetadataFlag(
  flag: string,
  value: string | undefined,
  metadata: CordnGroupMetadata,
): boolean {
  switch (flag) {
    case "--name":
      if (!value) throw new CliUsageError("Missing value for --name");
      metadata.name = value;
      return true;
    case "--description":
      if (!value) throw new CliUsageError("Missing value for --description");
      metadata.description = value;
      return true;
    case "--icon":
      if (!value) throw new CliUsageError("Missing value for --icon");
      metadata.icon = value;
      return true;
    case "--image-url":
      if (!value) throw new CliUsageError("Missing value for --image-url");
      metadata.imageUrl = value;
      return true;
    case "--admin":
      if (!value) throw new CliUsageError("Missing value for --admin");
      metadata.adminPubkeys = [...(metadata.adminPubkeys ?? []), value];
      return true;
    default:
      return false;
  }
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

    if (flag === "--watch") {
      watch = true;
      index += 1;
      continue;
    }

    if (flag === "--coordinator") {
      if (!value) throw new CliUsageError("Missing value for --coordinator");
      coordinatorKey = value;
      index += 2;
      continue;
    }

    if (applyMetadataFlag(flag, value, metadata)) {
      metadataProvided = true;
      index += 2;
      continue;
    }

    throw new CliUsageError(`Unknown create-group option: ${flag}`);
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

export function parseUpdateGroupMetadataArgs(args: string[]): {
  alias: string;
  metadata: CordnGroupMetadata;
} {
  const alias = args[0];

  if (!alias) {
    throw new CliUsageError(
      "Usage: update-group-metadata <groupAlias> --name <value> [--description <value>] [--icon <value>] [--image-url <value>] [--admin <hex>]...",
    );
  }

  const metadata: CordnGroupMetadata = { name: "" };
  let metadataProvided = false;
  let index = 1;

  while (index < args.length) {
    const flag = args[index];
    const value = args[index + 1];

    if (!flag?.startsWith("--")) {
      throw new CliUsageError(
        `Unexpected update-group-metadata argument: ${flag}`,
      );
    }

    if (applyMetadataFlag(flag, value, metadata)) {
      metadataProvided = true;
      index += 2;
      continue;
    }

    throw new CliUsageError(`Unknown update-group-metadata option: ${flag}`);
  }

  if (!metadataProvided || metadata.name === "") {
    throw new CliUsageError("update-group-metadata requires --name for v1");
  }

  return { alias, metadata };
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
    case "update-group-metadata":
    case "set-metadata": {
      const parsed = parseUpdateGroupMetadataArgs(args);
      await session.syncGroup(parsed.alias);
      const result = await session.updateGroupMetadata(
        parsed.alias,
        parsed.metadata,
      );
      await session.syncGroup(parsed.alias);
      output.write(
        `${colorize("updated metadata", ansi.green)} ${colorize(parsed.alias, ansi.cyan)} ${formatGroupMetadata(result.metadata)}\n`,
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
      await session.syncGroup(args[0]);
      const result = await session.addMember(args[0], args[1]);
      await session.syncGroup(args[0]);
      output.write(
        `${colorize("stored welcome", ansi.green)} ${colorize(result.keyPackageReference, ansi.dim)}\n`,
      );
      break;
    }
    case "remove-member": {
      if (!args[0] || !args[1]) {
        throw new CliUsageError(
          "Usage: remove-member <groupAlias> <stablePubkey>",
        );
      }
      await session.syncGroup(args[0]);
      const result = await session.removeMember(args[0], args[1]);
      await session.syncGroup(args[0]);
      output.write(
        `${colorize("removed member", ansi.yellow)} ${colorize(result.targetStablePubkey, ansi.dim)}\n`,
      );
      break;
    }
    case "fetch-welcomes": {
      const welcomes = await session.fetchWelcomes(
        parseCoordinatorOption(args),
      );
      output.write(
        `${formatList(welcomes.map((welcome) => `${formatWelcomeKeyPackageReference(welcomeIdentifier(welcome))} keyPackageRef=${formatKeyPackageRef(welcome.kp_ref)} at=${welcome.at}`))}\n`,
      );
      break;
    }
    case "welcomes": {
      output.write(
        `${formatList(session.listWelcomes().map((welcome) => `${formatWelcomeKeyPackageReference(welcomeIdentifier(welcome))} keyPackageRef=${formatKeyPackageRef(welcome.kp_ref)} at=${welcome.at}`))}\n`,
      );
      break;
    }
    case "fetch-join-requests": {
      if (!args[0] && !selectedGroupAlias) {
        throw new CliUsageError("Usage: fetch-join-requests <groupAlias>");
      }
      const alias = args[0] ?? selectedGroupAlias!;
      const result = await session.fetchPendingJoinRequests(alias);
      if (result.requests.length === 0) {
        output.write(
          `${colorize("no pending join requests", ansi.yellow)} for ${colorize(alias, ansi.cyan)}\n`,
        );
      } else {
        output.write(
          `${formatList(result.requests.map((req) => `pk=${formatFullCredentialLabel(req.pk)} kp_ref=${formatKeyPackageRef(req.kp_ref)} at=${colorize(String(req.at), ansi.dim)}`))}\n`,
        );
      }
      break;
    }
    case "request-join": {
      if (!args[0]) {
        throw new CliUsageError(
          "Usage: request-join <gid> [keyPackageAlias] [--coordinator <pubkey>]",
        );
      }
      const gid = args[0];
      const keyPackageAlias =
        args[1] ?? session.listKeyPackageSummaries()[0]?.alias;
      if (!keyPackageAlias) {
        throw new CliUsageError(
          "No key package available and none specified. Generate one with gen-kp first.",
        );
      }
      const result = await session.storeJoinRequest(
        gid,
        keyPackageAlias,
        parseCoordinatorOption(args),
      );
      output.write(
        `${colorize("stored join request", ansi.green)} gid=${colorize(gid, ansi.cyan)} kp_ref=${formatKeyPackageRef(result.keyPackageRef)} at=${colorize(String(result.at), ansi.dim)}\n`,
      );
      break;
    }
    case "accept-welcome": {
      if (!positionalArgs[0]) {
        throw new CliUsageError(
          "Usage: accept-welcome <welcomeIdOrKeyPackageReference> [groupAlias] [--coordinator <pubkey>] [--watch]",
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
    case "send-media": {
      if (!selectedGroupAlias) {
        throw new CliUsageError(
          "No selected group. Use `use <groupAlias>` first.",
        );
      }
      const filePath = args[0];
      if (!filePath)
        throw new CliUsageError("Usage: send-media <filePath> [caption...]");
      const caption = args.length > 1 ? args.slice(1).join(" ") : undefined;
      const plaintext = Uint8Array.from(await readFile(filePath));
      const filename = basename(filePath);
      const mediaStored = await session.sendMedia(selectedGroupAlias, {
        plaintext,
        metadata: { mime: inferMimeType(filename), filename },
        caption,
      });
      output.write(
        `${colorize("sent media", ansi.green)} ${colorize(filename, ansi.bold)} cursor=${colorize(String(mediaStored.cursor), ansi.bold)}\n`,
      );
      break;
    }
    case "save-media": {
      let alias: string | undefined;
      let cursorArg: string | undefined;
      let destDir = ".";
      const first = args[0];
      if (!first)
        throw new CliUsageError(
          "Usage: save-media [groupAlias] <cursor> [destDir]",
        );
      if (/^\d+$/.test(first)) {
        cursorArg = first;
        alias = selectedGroupAlias;
        if (args[1]) destDir = args[1];
      } else {
        alias = first;
        cursorArg = args[1];
        if (args[2]) destDir = args[2];
      }
      if (!alias)
        throw new CliUsageError(
          "No selected group. Use `use <groupAlias>` first.",
        );
      if (!cursorArg)
        throw new CliUsageError(
          "Usage: save-media [groupAlias] <cursor> [destDir]",
        );
      const { plaintext, metadata } = await session.decryptMediaMessage(
        alias,
        Number(cursorArg),
      );
      const destPath = join(destDir, metadata.filename);
      await writeFile(destPath, plaintext);
      output.write(
        `${colorize("saved media", ansi.green)} ${colorize(destPath, ansi.bold)} (${plaintext.length} bytes)\n`,
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

// ponytail: minimal extension→MIME map for the dev client. The sender's MIME is
// display-only metadata (it is read back from `imeta` by receivers), so a flat
// default is fine; extend only if a real client needs more types.
function inferMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "mp4":
      return "video/mp4";
    case "mp3":
      return "audio/mpeg";
    case "txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}
