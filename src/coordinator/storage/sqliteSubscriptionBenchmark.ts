import { Coordinator } from "../coordinator.ts";
import { createPrivateMessage } from "../testUtils.ts";
import { SqliteCoordinatorStorage } from "./sqliteStorage.ts";

interface ScenarioResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
}

interface BenchmarkConfig {
  groupCount: number;
  backlogMessagesPerGroup: number;
  liveMessagesPerGroup: number;
  iterations: number;
}

function getExpectedBacklogCount(
  afterCursor: number,
  backlogMessagesPerGroup: number,
): number {
  return Math.max(0, backlogMessagesPerGroup - afterCursor);
}

interface SeededCoordinator {
  coordinator: Coordinator;
  close: () => void;
  groups: Array<{
    groupId: string;
    afterCursor: number;
  }>;
}

async function consumeRecords(
  messages: AsyncIterable<unknown>,
  expectedCount: number,
): Promise<void> {
  const iterator = messages[Symbol.asyncIterator]();

  try {
    for (let index = 0; index < expectedCount; index += 1) {
      const result = await iterator.next();
      if (result.done) {
        throw new Error(
          `Subscription ended early after ${index} records, expected ${expectedCount}`,
        );
      }
    }
  } finally {
    await iterator.return?.();
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }

  return parsed;
}

function createBenchmarkConfig(): BenchmarkConfig {
  return {
    groupCount: readPositiveIntEnv("CORDN_BENCH_GROUPS", 32),
    backlogMessagesPerGroup: readPositiveIntEnv("CORDN_BENCH_BACKLOG", 64),
    liveMessagesPerGroup: readPositiveIntEnv("CORDN_BENCH_LIVE", 16),
    iterations: readPositiveIntEnv("CORDN_BENCH_ITERATIONS", 100),
  };
}

function createSeededCoordinator(config: BenchmarkConfig): SeededCoordinator {
  const storage = new SqliteCoordinatorStorage({ path: ":memory:" });
  const coordinator = new Coordinator({ storage });
  const groups = Array.from({ length: config.groupCount }, (_, index) => {
    const groupId = `bench-group-${index + 1}`;

    for (
      let messageIndex = 0;
      messageIndex < config.backlogMessagesPerGroup;
      messageIndex += 1
    ) {
      coordinator.postGroupMessage({
        opaqueMessage: createPrivateMessage({
          groupId,
          epoch: 1n,
          contentType: 1,
          bytes: [messageIndex % 251],
        }),
      });
    }

    return {
      groupId,
      afterCursor: Math.floor(config.backlogMessagesPerGroup / 2),
    };
  });

  return {
    coordinator,
    groups,
    close: () => storage.close(),
  };
}

async function measure(
  name: string,
  iterations: number,
  run: () => Promise<void>,
): Promise<ScenarioResult> {
  const start = process.hrtime.bigint();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await run();
  }

  const totalMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  return {
    name,
    iterations,
    totalMs,
    avgMs: totalMs / iterations,
  };
}

function formatResult(result: ScenarioResult): string {
  return [
    result.name.padEnd(34, " "),
    `total=${result.totalMs.toFixed(2)}ms`,
    `avg=${result.avgMs.toFixed(4)}ms`,
    `iterations=${result.iterations}`,
  ].join("  ");
}

async function benchmarkSingleSubscriptions(
  coordinator: Coordinator,
  groups: SeededCoordinator["groups"],
  backlogMessagesPerGroup: number,
  liveMessagesPerGroup: number,
): Promise<void> {
  const expectedPerGroup =
    getExpectedBacklogCount(groups[0]!.afterCursor, backlogMessagesPerGroup) +
    liveMessagesPerGroup;
  const subscriptions = groups.map((group) =>
    coordinator.subscribeGroupMessages(group),
  );
  const consumers = subscriptions.map(async (subscription, index) => {
    const group = groups[index]!;
    const backlog = coordinator.fetchGroupMessages(group);
    const consumed = backlog.length;

    if (consumed > expectedPerGroup) {
      throw new Error(
        `Fetched ${consumed} backlog records for ${group.groupId}, expected at most ${expectedPerGroup}`,
      );
    }

    await consumeRecords(subscription.messages, expectedPerGroup - consumed);
  });

  for (const { groupId } of groups) {
    for (
      let messageIndex = 0;
      messageIndex < liveMessagesPerGroup;
      messageIndex += 1
    ) {
      coordinator.postGroupMessage({
        opaqueMessage: createPrivateMessage({
          groupId,
          epoch: 1n,
          contentType: 1,
          bytes: [messageIndex % 251],
        }),
      });
    }
  }

  try {
    await Promise.all(consumers);
  } finally {
    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
  }
}

async function benchmarkMultiSubscription(
  coordinator: Coordinator,
  groups: SeededCoordinator["groups"],
  backlogMessagesPerGroup: number,
  liveMessagesPerGroup: number,
): Promise<void> {
  const subscription = coordinator.subscribeManyGroupMessages({ groups });
  const expectedPerGroup =
    getExpectedBacklogCount(groups[0]!.afterCursor, backlogMessagesPerGroup) +
    liveMessagesPerGroup;
  const expectedTotal = expectedPerGroup * groups.length;
  const consumer = consumeRecords(subscription.messages, expectedTotal);

  for (const { groupId } of groups) {
    for (
      let messageIndex = 0;
      messageIndex < liveMessagesPerGroup;
      messageIndex += 1
    ) {
      coordinator.postGroupMessage({
        opaqueMessage: createPrivateMessage({
          groupId,
          epoch: 1n,
          contentType: 1,
          bytes: [messageIndex % 251],
        }),
      });
    }
  }

  try {
    await consumer;
  } finally {
    subscription.unsubscribe();
  }
}

async function main(): Promise<void> {
  const config = createBenchmarkConfig();

  const singleResult = await measure(
    "Equivalent N x single-group streams",
    config.iterations,
    async () => {
      const seeded = createSeededCoordinator(config);
      try {
        await benchmarkSingleSubscriptions(
          seeded.coordinator,
          seeded.groups,
          config.backlogMessagesPerGroup,
          config.liveMessagesPerGroup,
        );
      } finally {
        seeded.close();
      }
    },
  );

  const multiResult = await measure(
    "Equivalent 1 x multi-group stream",
    config.iterations,
    async () => {
      const seeded = createSeededCoordinator(config);
      try {
        await benchmarkMultiSubscription(
          seeded.coordinator,
          seeded.groups,
          config.backlogMessagesPerGroup,
          config.liveMessagesPerGroup,
        );
      } finally {
        seeded.close();
      }
    },
  );

  const speedup = singleResult.totalMs / multiResult.totalMs;

  console.log("SQLite realistic subscription benchmark");
  console.log(
    `groups=${config.groupCount} backlogPerGroup=${config.backlogMessagesPerGroup} livePerGroup=${config.liveMessagesPerGroup} iterations=${config.iterations}`,
  );
  console.log("");
  console.log(formatResult(singleResult));
  console.log(formatResult(multiResult));
  console.log("");
  console.log(`multi-vs-single speedup: ${speedup.toFixed(2)}x`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
