import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

import { CliSession } from "./session.ts"

const ansi = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
} as const

function supportsColor(): boolean {
  return Boolean(output.isTTY && process.env.NO_COLOR === undefined)
}

function colorize(text: string, ...codes: string[]): string {
  if (!supportsColor() || codes.length === 0) {
    return text
  }

  return `${codes.join("")}${text}${ansi.reset}`
}

function formatList(values: string[]): string {
  return values.length === 0 ? "(none)" : values.join("\n")
}

function printHelp(): void {
  output.write([
    "Commands:",
    "  help",
    "  status",
    "  whoami",
    "  gen-kp [alias]",
    "  key-packages",
    "  publish-kp <alias>",
    "  available-kps",
    "  create-group <alias> [keyPackageAlias]",
    "  groups",
    "  group <groupAlias>",
    "  use <groupAlias>",
    "  leave",
    "  add-member <groupAlias> <targetStablePubkey>",
    "  fetch-welcomes",
    "  welcomes",
    "  accept-welcome <welcomeId> [groupAlias]",
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
  ].join("\n"))
}

function trimSenderLabel(sender: string): string {
  return sender.length <= 6 ? sender : sender.slice(0, 6)
}

function formatCredentialLabel(sender: string): string {
  const trimmed = trimSenderLabel(sender)
  const red = Number.parseInt(trimmed.slice(0, 2), 16)
  const green = Number.parseInt(trimmed.slice(2, 4), 16)
  const blue = Number.parseInt(trimmed.slice(4, 6), 16)
  return colorize(trimmed, `\u001b[38;2;${red};${green};${blue}m`)
}

function formatCursor(cursor: number): string {
  return colorize(`[${cursor}]`, ansi.dim)
}

function formatKeyPackageRef(ref: string): string {
  return colorize(ref, ansi.dim)
}

function formatTimestamp(value: number | string): string {
  return colorize(String(value), ansi.dim)
}

function formatGroupAlias(alias: string): string {
  return colorize(alias, ansi.cyan)
}

function formatWelcomeId(welcomeId: string): string {
  return colorize(welcomeId, ansi.magenta)
}

function formatStatusValue(value: string | number): string {
  return colorize(String(value), ansi.bold)
}

function formatChatLine(direction: "inbound" | "outbound", cursor: number, sender: string, plaintext: string): string {
  const credential = formatCredentialLabel(sender)
  const label = direction === "outbound" ? `${colorize("you", ansi.green)}/${credential}` : credential
  return `${formatCursor(cursor)} ${label}: ${plaintext}`
}

function formatChatHistory(session: CliSession, groupAlias: string): string {
  return formatList(session.listMessages(groupAlias).map((message) => formatChatLine(message.direction, message.cursor, message.sender, message.plaintext)))
}

export async function startCliRepl(session: CliSession): Promise<void> {
  const rl = createInterface({ input, output })
  let selectedGroupAlias: string | undefined

  printHelp()

  try {
    while (true) {
      const prompt = selectedGroupAlias ? `cvm-mls:${selectedGroupAlias}> ` : "cvm-mls> "
      const line = (await rl.question(prompt)).trim()

      if (!line) {
        if (selectedGroupAlias) {
          try {
            const messages = await session.syncGroup(selectedGroupAlias)
            output.write(`${formatList(messages.map((message) => formatChatLine(message.direction, message.cursor, message.sender, message.plaintext)))}\n`)
          } catch (error) {
            output.write(`${colorize(error instanceof Error ? error.message : String(error), ansi.red)}\n`)
          }
        }
        continue
      }

      const [rawCommand = "", ...args] = line.split(/\s+/)
      const command = rawCommand
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
      ])

      if (selectedGroupAlias && !knownCommands.has(command)) {
        try {
          const stored = await session.sendMessage(selectedGroupAlias, line)
          output.write(`sent cursor=${stored.cursor}\n`)
        } catch (error) {
          output.write(`${error instanceof Error ? error.message : String(error)}\n`)
        }
        continue
      }

      try {
        switch (command) {
          case "help": {
            printHelp()
            break
          }
          case "status": {
            const status = session.getStatus()
            output.write([
              `${colorize("stablePubkey", ansi.cyan)}: ${formatCredentialLabel(status.stablePubkey)}`,
              `${colorize("keyPackageCount", ansi.cyan)}: ${formatStatusValue(status.keyPackageCount)}`,
              `${colorize("welcomeCount", ansi.cyan)}: ${formatStatusValue(status.welcomeCount)}`,
              `${colorize("groupCount", ansi.cyan)}: ${formatStatusValue(status.groupCount)}`,
            ].join("\n") + "\n")
            break
          }
          case "whoami": {
            output.write(`stablePubkey: ${formatCredentialLabel(session.stablePubkey)}\nprivateKey: ${colorize(session.privateKey, ansi.dim)}\n`)
            break
          }
          case "gen-kp": {
            const result = await session.generateKeyPackage(args[0])
            output.write(`${colorize("generated", ansi.green)} ${result.alias} (${colorize(result.keyPackageRef, ansi.dim)})\n`)
            break
          }
          case "key-packages": {
            output.write(`${formatList(session.listKeyPackages().map((entry) => `${formatGroupAlias(entry.alias)} ref=${formatKeyPackageRef(entry.keyPackageRef)} published=${entry.publishedAt === undefined ? colorize("no", ansi.yellow) : formatTimestamp(entry.publishedAt)} consumed=${entry.consumed ? colorize("yes", ansi.green) : colorize("no", ansi.yellow)}`))}\n`)
            break
          }
          case "publish-kp": {
            if (!args[0]) throw new Error("Usage: publish-kp <alias>")
            const result = await session.publishKeyPackage(args[0])
            output.write(`${colorize("published", ansi.green)} ${result.alias} at ${colorize(String(result.publishedAt), ansi.dim)}\n`)
            break
          }
          case "available-kps": {
            const keyPackages = await session.listAvailableKeyPackages()
            output.write(`${formatList(keyPackages.map((entry) => `${formatCredentialLabel(entry.stablePubkey)} ref=${formatKeyPackageRef(entry.keyPackageRef)} published=${formatTimestamp(entry.publishedAt)}`))}\n`)
            break
          }
          case "create-group": {
            if (!args[0]) throw new Error("Usage: create-group <alias> [keyPackageAlias]")
            const group = await session.createGroup(args[0], args[1])
            selectedGroupAlias = group.alias
            output.write(`${colorize("created group", ansi.green)} ${colorize(group.alias, ansi.cyan)}\n`)
            break
          }
          case "groups": {
            output.write(`${formatList(session.listGroups().map((group) => `${formatGroupAlias(group.alias)} cursor=${colorize(String(group.lastCursor), ansi.bold)} messages=${colorize(String(group.messages.length), ansi.bold)}`))}\n`)
            break
          }
          case "group":
          case "use": {
            if (!args[0]) throw new Error("Usage: use <groupAlias>")
            session.getGroup(args[0])
            selectedGroupAlias = args[0]
            output.write(`${colorize("selected group", ansi.green)} ${colorize(selectedGroupAlias, ansi.cyan)}\n`)
            break
          }
          case "leave": {
            selectedGroupAlias = undefined
            output.write(`${colorize("left", ansi.yellow)} group context\n`)
            break
          }
          case "add-member": {
            if (!args[0] || !args[1]) throw new Error("Usage: add-member <groupAlias> <targetStablePubkey>")
            const result = await session.addMember(args[0], args[1])
            output.write(`${colorize("stored welcome", ansi.green)} ${colorize(result.welcomeId, ansi.dim)}\n`)
            break
          }
          case "fetch-welcomes": {
            const welcomes = await session.fetchWelcomes()
            output.write(`${formatList(welcomes.map((welcome) => `${formatWelcomeId(welcome.welcomeId)} keyPackageRef=${formatKeyPackageRef(welcome.keyPackageReference)}`))}\n`)
            break
          }
          case "welcomes": {
            output.write(`${formatList(session.listWelcomes().map((welcome) => `${formatWelcomeId(welcome.welcomeId)} keyPackageRef=${formatKeyPackageRef(welcome.keyPackageReference)}`))}\n`)
            break
          }
          case "accept-welcome": {
            if (!args[0]) throw new Error("Usage: accept-welcome <welcomeId> [groupAlias]")
            const group = await session.acceptWelcome(args[0], args[1])
            selectedGroupAlias = group.alias
            output.write(`${colorize("accepted welcome into", ansi.green)} ${colorize(group.alias, ansi.cyan)}\n`)
            break
          }
          case "send": {
            if (!selectedGroupAlias) throw new Error("No selected group. Use `use <groupAlias>` first.")
            if (args.length === 0) throw new Error("Usage: send <message...>")
            const stored = await session.sendMessage(selectedGroupAlias, args.join(" "))
            output.write(`${colorize("sent", ansi.green)} cursor=${colorize(String(stored.cursor), ansi.bold)}\n`)
            break
          }
          case "send-to": {
            if (!args[0] || args.length < 2) throw new Error("Usage: send-to <groupAlias> <message...>")
            const stored = await session.sendMessage(args[0], args.slice(1).join(" "))
            output.write(`${colorize("sent", ansi.green)} cursor=${colorize(String(stored.cursor), ansi.bold)}\n`)
            break
          }
          case "sync": {
            const alias = args[0] ?? selectedGroupAlias
            if (!alias) throw new Error("Usage: sync <groupAlias>")
            const messages = await session.syncGroup(alias)
            output.write(`${formatList(messages.map((message) => formatChatLine(message.direction, message.cursor, message.sender, message.plaintext)))}\n`)
            break
          }
          case "sync-all": {
            const result = await session.syncAll()
            output.write(`${JSON.stringify(result, null, 2)}\n`)
            break
          }
          case "messages": {
            const alias = args[0] ?? selectedGroupAlias
            if (!alias) throw new Error("Usage: messages <groupAlias>")
            await session.syncGroup(alias)
            output.write(`${formatChatHistory(session, alias)}\n`)
            break
          }
          case "issues": {
            const alias = args[0] ?? selectedGroupAlias
            if (!alias) throw new Error("Usage: issues <groupAlias>")
            output.write(`${formatList(session.listSyncIssues(alias).map((issue) => `${formatCursor(issue.cursor)} ${colorize(issue.detail, ansi.yellow)}`))}\n`)
            break
          }
          case "exit":
          case "quit": {
            return
          }
          default: {
            throw new Error(`Unknown command: ${command}`)
          }
        }
      } catch (error) {
        output.write(`${colorize(error instanceof Error ? error.message : String(error), ansi.red)}\n`)
      }
    }
  } finally {
    rl.close()
  }
}
