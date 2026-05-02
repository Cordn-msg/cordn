import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { CliSession } from "./session.ts";
import {
  executeReplCommand,
  knownCommands,
  tokenizeInput,
} from "./replCommands.ts";
import {
  ansi,
  colorize,
  formatPromptGroupLabel,
  formatSyncResult,
  printHelp,
} from "./replFormat.ts";

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
        const result = await executeReplCommand(command, args, {
          session,
          output,
          selectedGroupAlias,
        });

        selectedGroupAlias = result.selectedGroupAlias;

        if (result.shouldExit) {
          return;
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
