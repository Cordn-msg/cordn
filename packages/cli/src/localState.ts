import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface EncryptedStateEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

async function readOrCreateKey(keyPath: string): Promise<Buffer> {
  try {
    const key = Buffer.from((await readFile(keyPath, "utf8")).trim(), "hex");
    if (key.length !== 32) throw new Error("state key must be 32 bytes");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    await writeFile(keyPath, `${key.toString("hex")}\n`, { mode: 0o600 });
    await chmod(keyPath, 0o600);
    return key;
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
  const key = await readOrCreateKey(keyPath);
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
  const key = await readOrCreateKey(keyPath);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
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
  await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
}
