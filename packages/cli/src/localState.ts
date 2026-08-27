import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

interface EncryptedStateEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

async function readKey(keyPath: string): Promise<Buffer> {
  const encoded = (await readFile(keyPath, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/i.test(encoded)) {
    throw new Error("state key must be exactly 32 bytes encoded as hex");
  }
  return Buffer.from(encoded, "hex");
}

async function readOrCreateKey(keyPath: string): Promise<Buffer> {
  try {
    return await readKey(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    try {
      await writeFile(keyPath, `${key.toString("hex")}\n`, {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
      await syncDirectory(dirname(keyPath));
      return key;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code === "EEXIST") {
        return readKey(keyPath);
      }
      throw writeError;
    }
  }
}

export async function loadEncryptedState<T>(
  statePath: string,
  keyPath: string,
): Promise<T | undefined> {
  let envelope: EncryptedStateEnvelope;
  try {
    envelope = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (envelope.version !== 1) throw new Error("unsupported state version");
  const key = await readKey(keyPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`state key file not found: ${keyPath}`);
    }
    throw error;
  });
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export async function saveEncryptedState(
  statePath: string,
  keyPath: string,
  value: unknown,
): Promise<void> {
  // Capture mutable session state synchronously before the first await; watch
  // ingestion can otherwise change live arrays while the key file is read.
  const plaintext = JSON.stringify(value);
  const key = await readOrCreateKey(keyPath);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const envelope: EncryptedStateEnvelope = {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  // Multiple group events can request persistence concurrently. A shared
  // `.tmp` name lets one save rename another save's file out from under it.
  const temporary = `${statePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(envelope)}\n`, {
    mode: 0o600,
    flush: true,
  });
  await rename(temporary, statePath);
  await syncDirectory(dirname(statePath));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Exclusive process lock: one MLS session writer per state file. */
export async function acquireStateLock(
  statePath: string,
): Promise<() => Promise<void>> {
  const lockPath = `${statePath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await unlink(lockPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let encodedOwner: string;
      try {
        encodedOwner = (await readFile(lockPath, "utf8")).trim();
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      if (!/^\d+$/.test(encodedOwner)) {
        throw new Error(`state lock is invalid; remove ${lockPath} manually`);
      }
      const owner = Number(encodedOwner);
      if (owner > 0 && isProcessRunning(owner)) {
        throw new Error(`state file is already in use by pid ${owner}`);
      }
      await unlink(lockPath).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw unlinkError;
        }
      });
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
