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
  for (const required of [
    "package/dist/cli.js",
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

  console.log(`pack smoke passed: ${archiveName}`);
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
