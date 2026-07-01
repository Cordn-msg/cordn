import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Content-addressed blob store for encrypted media. The session publishes an
 * encrypted blob and receives back a URL that group members later fetch to
 * decrypt. Any store that serves a blob by hash is interoperable; Blossom is
 * the recommended production backend (see `spec/applications/encrypted-media.md`).
 */
export interface MediaStore {
  /** Stores the blob and returns a URL that resolves back to it. */
  publish(blob: Uint8Array): Promise<string>;
  /** Fetches the blob previously published at the given URL. */
  fetch(url: string): Promise<Uint8Array>;
}

/**
 * Local content-addressed store for development and testing without a Blossom
 * server. Blobs are keyed by `sha256(blob)`; two CLI processes on the same
 * machine exchange media by pointing at the same directory. The URL scheme is
 * `media://<sha256-hex>`.
 *
 * ponytail: swap for a `BlossomMediaStore` when shipping real uploads; this
 * one exists so the encrypt/send → fetch/decrypt path is exercisable offline.
 */
export class FileMediaStore implements MediaStore {
  constructor(private readonly dir: string) {}

  async publish(blob: Uint8Array): Promise<string> {
    const hash = createHash("sha256").update(blob).digest("hex");
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, hash), blob);
    return `media://${hash}`;
  }

  async fetch(url: string): Promise<Uint8Array> {
    const hash = url.replace(/^media:\/\//, "");
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(
        `Unrecognized media URL (expected media://<sha256>): ${url}`,
      );
    }
    return Uint8Array.from(await readFile(join(this.dir, hash)));
  }
}
