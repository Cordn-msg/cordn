# Cordn Encrypted Media

- Status: Draft

## Abstract

This document defines how `cordn` clients encrypt and share media files (images, video, audio, documents) within a group while preserving the end-to-end confidentiality already provided by the sealed group-payload model defined in [`spec/03.md`](../03.md).

Media files are encrypted client-side with a key derived from the group's MLS exporter secret, uploaded to a content-addressed store, and referenced from a group message through [NIP-92](https://github.com/nostr-protocol/nips/blob/master/92.md) `imeta` tags. The coordinator is unchanged: it continues to treat group messages as opaque bytes, as required by [`spec/03.md`](../03.md). Blob storage, upload, and retrieval are entirely client-side concerns.

This document specifies the media encryption scheme, the `imeta` tag format, and the send/receive processing flow. Storage backend selection, client UX, and preview rendering are out of scope.

## Specification

### 1. Overview

Encrypted media reuses the content-protection model of [`spec/03.md`](../03.md) for a separate object class: media files.

- Media is encrypted client-side with a per-(group, epoch) key derived from the MLS exporter, using a dedicated exporter context.
- Encrypted blobs are stored on a content-addressed store chosen by the client. Blossom is RECOMMENDED.
- A media-bearing group message is an ordinary sealed group payload whose envelope carries an `imeta` tag referencing the encrypted blob.
- The coordinator gains no new surface. It does not store, address, parse, or validate media blobs.

### 2. Coordinator Involvement

None.

- The coordinator does not store, address, or validate media blobs.
- A media reference travels inside a sealed group payload, identical to any other group message from the coordinator's perspective.
- Blob storage is a client concern. This document constrains only how the client encrypts media and describes it in `imeta`.

This keeps the trust boundary established by [`spec/03.md`](../03.md) intact: the coordinator remains content-opaque.

### 3. Encryption Scheme

A media file is encrypted independently of the group-payload layer defined in [`spec/03.md`](../03.md). The two layers use distinct exporter contexts and do not interact.

#### 3.1 Key Derivation

The encryption key MUST be derived using the MLS Exporter with the following parameters:

- secret: the exporter secret of the relevant MLS epoch
- label: `"cordn"`
- context: the UTF-8 encoding of `"encrypted-media"`
- length: `32` bytes

The key rotates automatically with each MLS epoch advance, inheriting the forward-secrecy and post-compromise-security properties of the group. No additional KDF is layered on top of the exporter; the MLS Exporter is already a KDF.

#### 3.2 Associated Data

The AEAD associated data binds the blob to the metadata declared in `imeta`, so that rewiring an `imeta` onto a different blob is detectable. The AAD MUST be constructed as the byte concatenation:

```
aad = utf8(mime) || 0x00 || utf8(filename) || 0x00 || sha256(plaintext)
```

where:

- `mime` and `filename` are the exact UTF-8 byte sequences carried in the `imeta` `m` and `filename` fields. The sender MUST store the exact bytes it used in the AAD; the receiver feeds those same bytes back. No canonicalization is performed.
- `sha256(plaintext)` is the 32-byte hash of the original file content (also carried in `imeta` as `x`).
- `0x00` is a single null-byte separator between components.

#### 3.3 Encryption

The blob MUST use `ChaCha20-Poly1305` as the AEAD.

```
nonce = Random(12)
blob  = ChaCha20-Poly1305(key, nonce, aad).encrypt(plaintext)
```

In TLS notation:

```tls
opaque Nonce[12];
opaque Blob<..>;   // AEAD ciphertext and 16-byte authentication tag

struct {
    Nonce nonce;
    Blob  blob;
} EncryptedMedia;
```

Requirements:

- The nonce MUST be exactly 12 bytes, freshly generated at random for each media file, and MUST NOT be reused with the same key.
- The nonce MUST be stored in the `imeta` `n` field (hex-encoded) and MUST NOT be prepended to the stored blob. The stored blob is ciphertext plus the 16-byte authentication tag only.
- The encryption key is never transmitted, never stored in `imeta`, and never sent to the content store.

### 4. Versioning

This is version `cordn-em-v1` of the media encryption scheme.

- The `imeta` tag MUST carry `v cordn-em-v1`.
- Clients MUST reject tags whose `v` field is absent or names an unknown version, and SHOULD surface a clear error rather than attempting decryption.
- Domain separation between versions is provided by the exporter context: a future version MUST use a distinct context string (for example `encrypted-media-v2`), which yields a distinct key and prevents cross-version confusion.

There is no deprecated prior version. The `v` field exists solely to support future evolution.

### 5. `imeta` Tag Format

Media references use [NIP-92](https://github.com/nostr-protocol/nips/blob/master/92.md) `imeta` tags, carried inside the sealed cordn message envelope defined in [`spec/02.md`](../02.md). Because the envelope is itself sealed under the group-payload key ([`spec/03.md`](../03.md)), all `imeta` fields are confidential to group members; the content store sees only the encrypted blob.

```
imeta
  url <content-store-url>
  m <mime-type>
  filename <filename>
  x <sha256-of-plaintext-hex>
  n <nonce-hex>
  v cordn-em-v1
  [dim <WxH>]
  [blurhash <hash>]
  [thumbhash <hash>]
  [alt <description>]
```

Field requirements:

| Field       | Required | Meaning                                                     |
| ----------- | -------- | ----------------------------------------------------------- |
| `url`       | Yes      | Content-store URL of the encrypted blob                     |
| `m`         | Yes      | MIME type; exact bytes used in the AAD                      |
| `filename`  | Yes      | Original filename; exact bytes used in the AAD              |
| `x`         | Yes      | Lowercase hex SHA-256 of the original file content          |
| `n`         | Yes      | Lowercase hex encoding of the 12-byte nonce (24 characters) |
| `v`         | Yes      | Encryption version; `cordn-em-v1`                           |
| `dim`       | No       | Dimensions as `WxH` for image/video                         |
| `blurhash`  | No       | BlurHash preview                                            |
| `thumbhash` | No       | ThumbHash preview                                           |
| `alt`       | No       | Accessibility description                                   |

`dim`, `blurhash`, `thumbhash`, and `alt` are display hints. They do not participate in encryption or integrity and are passed through unchanged.

### 6. Content Storage

Encrypted blobs are stored on a content-addressed store addressed by `sha256(blob)`.

- The store address is the SHA-256 of the encrypted blob (ciphertext plus tag). It is opaque and reveals nothing about the plaintext.
- Upload, authentication, deletion, and retrieval are governed by the chosen store and are out of scope for this document.
- [Blossom](https://github.com/hzrd149/blossom) is RECOMMENDED as the default store because it provides content-addressed storage over HTTP with Nostr-based upload authentication, but any store that can serve a blob by its hash is interoperable.

A media reference is fully described by its `imeta` tag; no store-specific fields are normative.

### 7. Processing Flow

Sending:

1. Compute `x = sha256(plaintext)`.
2. Derive the key from the current epoch's exporter secret (§3.1).
3. Generate a fresh 12-byte random nonce.
4. Construct the AAD from `m`, `filename`, and `x` (§3.2).
5. Encrypt to produce the blob (§3.3).
6. Upload the blob to the content store; record its `url`.
7. Emit an `imeta` tag (§5) inside a sealed group message ([`spec/03.md`](../03.md)).

Receiving:

1. Parse the `imeta` tag from the decrypted group message.
2. Reject if `v` is absent or unknown.
3. Download the blob from `url`.
4. Reconstruct the AAD from `m`, `filename`, and `x`.
5. Derive the key from the epoch of the carrying group message, and decrypt with the nonce from `n`.
6. Verify `sha256(plaintext) == x`. Reject on mismatch.

### 8. Security Considerations

Protected:

- **Confidentiality.** Only holders of the epoch's exporter secret (current group members) can decrypt. The store and any network observer see only the encrypted blob.
- **Integrity.** AEAD verification plus the `x` check detect any tampering with or corruption of the blob.
- **Metadata binding.** The AAD prevents rewiring an `imeta` (mime, filename, `x`) onto the wrong blob.
- **Forward secrecy.** Inherited from MLS epoch rotation: members joining later cannot decrypt media sealed under prior epochs; removed members cannot decrypt new media.
- **Origin authenticity.** Inherited from the carrying group message: a recipient trusts media because its `imeta` arrived inside an MLS-authenticated message, not because the blob is self-authenticating.

Not protected (inherent to external content-addressed storage; out of scope for `cordn-em-v1`):

- **Blob size.** Ciphertext length approximates plaintext length plus 16 bytes; the store can infer approximate file size and, coarsely, type. The scheme does not pad.
- **Access patterns.** The store address `sha256(blob)` is stable, so the store can observe who fetches what, when, and correlate members pulling the same blob.
- **Timing.** Upload and download timestamps relative to group messages are visible to the store.
- **Prior disclosure.** Forward secrecy protects future media for a removed member, not files they already downloaded.
- **Key secrecy is load-bearing.** If an epoch's exporter secret leaks, every blob sealed under it remains on any store and becomes decryptable. Rotation is by MLS epoch advance; there is no per-file secret to rotate.

### 9. Interoperability Requirements

Implementations MUST agree on all of the following:

- the MLS Exporter parameters: label `"cordn"`, context `"encrypted-media"`, length `32`
- the AEAD algorithm (`ChaCha20-Poly1305`), nonce length (12 bytes), nonce uniqueness, and the AAD byte layout in §3.2
- the nonce is stored only in `imeta` `n` and is not prepended to the stored blob
- the `imeta` field set and the meaning of `v cordn-em-v1`
- the content-addressing rule `sha256(blob)` for store addressing
- rejection of absent or unknown `v` values
