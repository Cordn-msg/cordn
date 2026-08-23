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

export async function startCliRepl(
  session: CliSession,
  persist: () => Promise<void> = async () => undefined,
): Promise<void> {
  const rl = createInterface({ input, output });
  let selectedGroupAlias: string | undefined;
  let currentPrompt = "cordn> ";

  const renderPrompt = (): void => {
    currentPrompt = selectedGroupAlias
      ? `cordn:${formatPromptGroupLabel(session, selectedGroupAlias)}> `
      : "cordn> ";
  };

  const redrawAfterAsyncOutput = (): void => {
    output.write("\n");
    rl.prompt(true);
  };

  const unsubscribeWatchEvents = session.onGroupEvent((event) => {
    if (event.groupAlias !== selectedGroupAlias) {
      return;
    }

    if (event.type === "watch-status-changed") {
      if (!event.error) {
        return;
      }

      output.write(
        `${colorize(`watch error: ${event.error}`, ansi.red)} ${formatPromptGroupLabel(session, event.groupAlias)}\n`,
      );
      redrawAfterAsyncOutput();
      return;
    }

    for (const issue of event.issues) {
      output.write(
        `${colorize(issue.detail, ansi.yellow)} ${formatPromptGroupLabel(session, event.groupAlias)} ${formatSyncResult(session, event.groupAlias, [])}\n`,
      );
    }

    if (event.received.length === 0) {
      return;
    }

    output.write(
      `${formatSyncResult(session, event.groupAlias, event.received)}\n`,
    );
    redrawAfterAsyncOutput();
  });

  printHelp();

  try {
    while (true) {
      renderPrompt();
      rl.setPrompt(currentPrompt);
      const line = (await rl.question(currentPrompt)).trim();

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
          await persist();
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
        await persist();
        renderPrompt();

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
    unsubscribeWatchEvents();
    rl.close();
  }
}
