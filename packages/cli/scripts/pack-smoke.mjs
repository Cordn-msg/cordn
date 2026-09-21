import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDir = await mkdtemp(join(tmpdir(), "cordn-cli-pack-"));

try {
  await exec("pnpm", ["pack", "--pack-destination", temporaryDir], {
    cwd: packageDir,
  });
  const archiveName = (await readdir(temporaryDir)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (!archiveName) throw new Error("pnpm pack did not produce an archive");
  const archive = join(temporaryDir, archiveName);

  const { stdout: packedFiles } = await exec("tar", ["-tzf", archive]);
  if (/package\/src\//.test(packedFiles) || /\.test\.ts$/m.test(packedFiles)) {
    throw new Error("published archive contains source tests");
  }
  if (/package\/dist\/lib\/.*\.test\.js$/m.test(packedFiles)) {
    throw new Error("library emit contains test files");
  }
  if (
    /package\/dist\/lib\/(main|repl|replCommands|docs)\.js$/m.test(packedFiles)
  ) {
    throw new Error("library emit dragged in CLI-only modules");
  }
  for (const required of [
    "package/dist/cli.js",
    "package/dist/lib/index.js",
    "package/dist/lib/index.d.ts",
    "package/dist/lib/session.js",
    "package/dist/lib/persistentSession.js",
    "package/docs/AGENT.md",
    "package/docs/COMMANDS.md",
    "package/README.md",
    "package/LICENSE",
  ]) {
    if (!packedFiles.split("\n").includes(required)) {
      throw new Error(`published archive is missing ${required}`);
    }
  }

  const installDir = join(temporaryDir, "install");
  await mkdir(installDir);
  await writeFile(
    join(installDir, "package.json"),
    '{"name":"cordn-cli-pack-smoke","private":true}\n',
  );
  await exec(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive],
    { cwd: installDir },
  );

  const manifest = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );
  const executable = join(installDir, "node_modules", ".bin", "cordn");
  const { stdout: version } = await exec(executable, ["--version"], {
    cwd: installDir,
  });
  if (version.trim() !== manifest.version) {
    throw new Error(`unexpected version output: ${version.trim()}`);
  }
  const { stdout: help } = await exec(executable, ["--help"], {
    cwd: installDir,
  });
  if (!help.includes("docs [topic]")) {
    throw new Error("installed help does not advertise bundled docs");
  }
  const { stdout: agentDocs } = await exec(executable, ["docs", "agent"], {
    cwd: installDir,
  });
  if (!agentDocs.startsWith("# Agent usage")) {
    throw new Error("installed CLI could not read bundled agent docs");
  }
  const { stdout: commandDocs } = await exec(executable, ["docs", "commands"], {
    cwd: installDir,
  });
  if (!commandDocs.includes("publish-kp <alias>")) {
    throw new Error("installed CLI command reference is incomplete");
  }

  const stateFile = join(installDir, "state", "session.json");
  const { stdout: status } = await exec(
    executable,
    ["--state-file", stateFile, "--command", "status"],
    { cwd: installDir },
  );
  if (!status.includes("groupCount: 0")) {
    throw new Error("installed CLI could not bootstrap with hosted defaults");
  }

  const installedManifest = JSON.parse(
    await readFile(
      join(installDir, "node_modules", "@cordn", "cli", "package.json"),
      "utf8",
    ),
  );
  if (installedManifest.exports?.["."]?.import !== "./dist/lib/index.js") {
    throw new Error("publishConfig exports were not applied to the archive");
  }

  const libStateFile = join(installDir, "lib-state", "session.json");
  const { stdout: libSmoke } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { CliSession, openPersistentSession, DEFAULT_COORDINATOR_PUBKEY } from "@cordn/cli";
        const ephemeral = new CliSession({ serverPubkey: DEFAULT_COORDINATOR_PUBKEY });
        if (!/^[0-9a-f]{64}$/.test(ephemeral.stablePubkey)) throw new Error("bad pubkey");
        await ephemeral.disconnect();
        const opened = await openPersistentSession({ stateFile: process.argv[1] });
        await opened.persist();
        await opened.close();
        console.log(JSON.stringify({ ok: true, pubkey: opened.session.stablePubkey, coordinator: DEFAULT_COORDINATOR_PUBKEY }));
      `,
      libStateFile,
    ],
    { cwd: installDir },
  );
  const libResult = JSON.parse(libSmoke.trim().split("\n").at(-1));
  if (!libResult.ok || !/^[0-9a-f]{64}$/.test(libResult.pubkey)) {
    throw new Error("installed library import smoke failed");
  }
  const libStateDir = await readdir(join(installDir, "lib-state"));
  if (
    !libStateDir.includes("session.json") ||
    !libStateDir.includes("session.json.key") ||
    libStateDir.includes("session.json.lock")
  ) {
    throw new Error(
      `unexpected library state files: ${libStateDir.join(", ")}`,
    );
  }

  console.log(`pack smoke passed: ${archiveName}`);
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
