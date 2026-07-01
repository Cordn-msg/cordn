import { describe, expect, test } from "vitest";
import { createGroup, unsafeTestingAuthenticationService } from "ts-mls";

import {
  createActor,
  createMemberArtifacts,
  getTestCiphersuite,
} from "../../coordinator/testUtils.ts";
import {
  blobAddress,
  buildImetaTag,
  buildMediaAad,
  decryptMedia,
  encryptMedia,
  findImetaTag,
  parseImetaTag,
  type MediaMetadata,
} from "./mediaMessages.ts";

// Reuses the in-process MLS setup from mlsMessages.test.ts: a solo group state
// carries a real exporter secret, so encrypt/decrypt exercise real key
// derivation against ts-mls + @noble/ciphers. No network, no coordinator.
async function createSoloGroupState(groupId: string) {
  const cipherSuite = await getTestCiphersuite();
  const member = await createMemberArtifacts(createActor(groupId));
  return createGroup({
    context: { cipherSuite, authService: unsafeTestingAuthenticationService },
    groupId: new TextEncoder().encode(groupId),
    keyPackage: member.keyPackage,
    privateKeyPackage: member.privateKeyPackage,
  });
}

const fileBytes = () =>
  Uint8Array.from(Buffer.from("fake-image-bytes-not-a-real-image", "utf8"));

const meta: MediaMetadata = { mime: "image/png", filename: "cat.png" };

describe("encrypted media", () => {
  test("round-trips a file through encrypt/decrypt", async () => {
    const state = await createSoloGroupState("media-group-a");
    const plaintext = fileBytes();

    const enc = await encryptMedia({ state, plaintext, metadata: meta });

    expect(enc.nonce).toHaveLength(12);
    expect(enc.plaintextHash).toHaveLength(32);
    // blob = ciphertext + 16-byte Poly1305 tag.
    expect(enc.blob.length).toBe(plaintext.length + 16);

    const { plaintext: decrypted } = await decryptMedia({
      state,
      blob: enc.blob,
      nonce: enc.nonce,
      metadata: meta,
      expectedPlaintextHash: enc.plaintextHash,
    });
    expect(decrypted).toEqual(plaintext);
  });

  test("a different group cannot decrypt (key is group-scoped)", async () => {
    const stateA = await createSoloGroupState("media-group-a");
    const stateB = await createSoloGroupState("media-group-b");
    const plaintext = fileBytes();

    const enc = await encryptMedia({
      state: stateA,
      plaintext,
      metadata: meta,
    });

    await expect(
      decryptMedia({
        state: stateB,
        blob: enc.blob,
        nonce: enc.nonce,
        metadata: meta,
        expectedPlaintextHash: enc.plaintextHash,
      }),
    ).rejects.toThrow();
  });

  test("tampering with the blob is detected (AEAD)", async () => {
    const state = await createSoloGroupState("media-tamper");
    const enc = await encryptMedia({
      state,
      plaintext: fileBytes(),
      metadata: meta,
    });

    const tampered = Uint8Array.from(enc.blob);
    tampered[0] = tampered[0]! ^ 0xff;

    await expect(
      decryptMedia({
        state,
        blob: tampered,
        nonce: enc.nonce,
        metadata: meta,
        expectedPlaintextHash: enc.plaintextHash,
      }),
    ).rejects.toThrow();
  });

  test("rewiring metadata onto a blob fails (AAD binding)", async () => {
    const state = await createSoloGroupState("media-aad");
    const enc = await encryptMedia({
      state,
      plaintext: fileBytes(),
      metadata: meta,
    });

    // Same blob/nonce/key, different declared filename: the AAD reconstructed
    // at decrypt no longer matches the one used at encrypt, so AEAD must fail.
    await expect(
      decryptMedia({
        state,
        blob: enc.blob,
        nonce: enc.nonce,
        metadata: { mime: "image/png", filename: "dog.png" },
        expectedPlaintextHash: enc.plaintextHash,
      }),
    ).rejects.toThrow();

    // Likewise for a swapped MIME type.
    await expect(
      decryptMedia({
        state,
        blob: enc.blob,
        nonce: enc.nonce,
        metadata: { mime: "image/jpeg", filename: "cat.png" },
        expectedPlaintextHash: enc.plaintextHash,
      }),
    ).rejects.toThrow();
  });

  test("a wrong declared plaintext hash is rejected", async () => {
    const state = await createSoloGroupState("media-integrity");
    const enc = await encryptMedia({
      state,
      plaintext: fileBytes(),
      metadata: meta,
    });

    // A wrong `x` also breaks the AAD, so this is rejected at AEAD. It proves
    // the `x` field is bound into the ciphertext, not just checked after.
    const wrongHash = new Uint8Array(32).fill(1);
    await expect(
      decryptMedia({
        state,
        blob: enc.blob,
        nonce: enc.nonce,
        metadata: meta,
        expectedPlaintextHash: wrongHash,
      }),
    ).rejects.toThrow();
  });

  test("encrypting the same file twice yields distinct blobs (random nonce)", async () => {
    const state = await createSoloGroupState("media-nonce");
    const plaintext = fileBytes();

    const a = await encryptMedia({ state, plaintext, metadata: meta });
    const b = await encryptMedia({ state, plaintext, metadata: meta });

    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.blob).not.toEqual(b.blob);
    for (const enc of [a, b]) {
      const { plaintext: out } = await decryptMedia({
        state,
        blob: enc.blob,
        nonce: enc.nonce,
        metadata: meta,
        expectedPlaintextHash: enc.plaintextHash,
      });
      expect(out).toEqual(plaintext);
    }
  });

  test("blob address is sha256(blob) and stable per blob", async () => {
    const state = await createSoloGroupState("media-addr");
    const enc = await encryptMedia({
      state,
      plaintext: fileBytes(),
      metadata: meta,
    });

    expect(blobAddress(enc.blob)).toEqual(blobAddress(enc.blob));

    // Random nonce => distinct blob => distinct address. No cross-encryption
    // dedup correlation (an accepted privacy property in the spec).
    const enc2 = await encryptMedia({
      state,
      plaintext: fileBytes(),
      metadata: meta,
    });
    expect(blobAddress(enc.blob)).not.toEqual(blobAddress(enc2.blob));
  });

  test("AAD layout is mime || 0x00 || filename || 0x00 || plaintextHash", () => {
    const plaintextHash = new Uint8Array(32).fill(7);
    const aad = buildMediaAad(meta, plaintextHash);

    const expected = Uint8Array.from([
      ...Buffer.from("image/png", "utf8"),
      0x00,
      ...Buffer.from("cat.png", "utf8"),
      0x00,
      ...plaintextHash,
    ]);
    expect(Array.from(aad)).toEqual(Array.from(expected));
  });
});

describe("imeta tag", () => {
  test("round-trips all fields through build and parse", () => {
    const tag = buildImetaTag({
      url: "media://abc123",
      mime: "image/png",
      filename: "cat.png",
      plaintextHashHex: "a".repeat(64),
      nonceHex: "b".repeat(24),
      version: "cordn-em-v1",
      dim: "800x600",
      blurhash: "LF58Hj", // ponytail: dummy value, not a real blurhash
      alt: "a cat",
    });

    expect(tag[0]).toBe("imeta");
    const parsed = parseImetaTag(tag);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      url: "media://abc123",
      mime: "image/png",
      filename: "cat.png",
      plaintextHashHex: "a".repeat(64),
      nonceHex: "b".repeat(24),
      version: "cordn-em-v1",
      dim: "800x600",
      blurhash: "LF58Hj",
      alt: "a cat",
    });
  });

  test("values may contain spaces (first space separates key from value)", () => {
    const tag = buildImetaTag({
      url: "media://def",
      mime: "application/pdf",
      filename: "my holiday report.pdf",
      plaintextHashHex: "c".repeat(64),
      nonceHex: "d".repeat(24),
      version: "cordn-em-v1",
      alt: "a long alt description with spaces",
    });
    const parsed = parseImetaTag(tag);
    expect(parsed?.filename).toBe("my holiday report.pdf");
    expect(parsed?.alt).toBe("a long alt description with spaces");
  });

  test("parse returns null when a required field is missing", () => {
    const tag = [
      "imeta",
      "url media://x",
      "m image/png",
      // filename, x, n, v omitted
    ];
    expect(parseImetaTag(tag)).toBeNull();
  });

  test("parse returns null for a non-imeta tag", () => {
    expect(parseImetaTag(["e", "url media://x"])).toBeNull();
  });

  test("findImetaTag returns the first media reference and skips other tags", () => {
    const tags: string[][] = [
      ["e", "unrelated"],
      buildImetaTag({
        url: "media://first",
        mime: "image/png",
        filename: "a.png",
        plaintextHashHex: "1".repeat(64),
        nonceHex: "2".repeat(24),
        version: "cordn-em-v1",
      }),
    ];
    const ref = findImetaTag(tags);
    expect(ref?.url).toBe("media://first");
    expect(findImetaTag([])).toBeNull();
  });
});
