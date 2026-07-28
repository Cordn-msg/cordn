# @cordn/sdk

High-level TypeScript SDK for building cordn applications. Encapsulates the
MLS-over-coordinator gotchas the CLI and cordn-web each had to learn
independently, behind a transport- and storage-agnostic surface. See
[`design/cordn-sdk.md`](../../design/cordn-sdk.md) for the full design.

> **Status:** the engine, client facade, managers, serialize/recover, and the
> production **`ContextVmTransport`** (a thin `@contextvm/sdk` client) are
> implemented and tested. The publish→consume and message round-trips run over a
> real `@contextvm/sdk` relay against a real server + coordinator (in-memory
> relay in tests; live relays in production).

## Layers

```
Client      CordnClient + managers (keyPackages, groups, invites, joinRequests)
Engine      CordnGroupEngine — transport-agnostic state machine
              (lifecycle, dispositions, serialization, serialize/recover)
Core        @cordn/core (contracts, codecs, metadata ext)
Foundation  ts-mls (RFC 9420) — consumed, not encapsulated
```

## Quick start

```ts
import { CordnClient } from "@cordn/sdk";
import { proposeAddMember } from "@cordn/sdk";
import { InMemoryKeyValueStore } from "@cordn/sdk/extra";
import { createInProcessTransport } from "@cordn/sdk/testing";
import { createPrivateKeySigner } from "@cordn/sdk/testing";
import { getTestCiphersuite } from "@cordn/test-utils";

const cipherSuite = await getTestCiphersuite();
const { transport } = createInProcessTransport();

const alice = new CordnClient({
  signer: createPrivateKeySigner(), // app implements CordnSigner over window.nostr (NIP-07)
  transport,
  ciphersuite: cipherSuite,
  keyPackageStorage: new InMemoryKeyValueStore(),
});
const bob = new CordnClient({
  /* …same shape… */
});

// Publish key packages (signs the publication binding).
const aliceKp = await alice.keyPackages.generate();
await alice.keyPackages.publish(aliceKp.keyPackageRef);
const bobKp = await bob.keyPackages.generate();
await bob.keyPackages.publish(bobKp.keyPackageRef);

// Alice creates a group and adds Bob.
const group = await alice.groups.create({
  groupId: "chat",
  metadata: { name: "Chat" },
});
const bobPublished = await alice.keyPackages.consume(bobKp.keyPackageRef);
await group.commit([proposeAddMember(bobPublished.keyPackage)]);
await group.fetch(); // confirm own commit → stores Bob's welcome

// Bob joins from the welcome (joinAfterCursor skips pre-join traffic).
const [welcome] = await bob.invites.fetch();
const bobGroup = await bob.groups.joinFromWelcome({
  welcome: welcome.welcome,
  keyPackageRef: welcome.keyPackageReference,
  joinAfterCursor: welcome.joinAfterCursor,
});

// Exchange messages.
await group.send(new TextEncoder().encode("hi"));
for await (const result of bobGroup.runInbox()) {
  if (result.disposition === "processed" && result.applicationMessage) {
    console.log(new TextDecoder().decode(result.applicationMessage)); // "hi"
  }
}
```

## Key concepts

**Three key layers** — don't confuse them:

1. **Identity key** (stable Nostr pubkey, from `CordnSigner`) → BasicCredential identity, authed-channel signing, publication-payload signature.
2. **MLS leaf keys** (ts-mls-generated) → live inside `PrivateKeyPackage`s, stored in `keyPackageStorage`.

**Dual transport is a privacy invariant, not a config knob.** The SDK owns the
method→channel routing table; transports expose the channels; apps never pick a
channel per call. (Authed: publish/remove key packages, fetch welcomes, store
join requests. Ephemeral: all group traffic, consume/list key packages, store
welcomes, fetch join requests.)

**Serialize / recover** — `group.serialize()` snapshots state, pending epoch
ops, in-flight refs, lifecycle, status, and cursors; `client.groups.load(blob)`
restores it. The app owns persistence cadence and the storage backend. A
snapshot taken between publish and self-echo restores the pending op, so a crash
no longer strands a welcome.

**ProposalActions** compose into batched commits:

```ts
await group.commit([proposeAddMember(bobKp), proposeAddMember(carolKp)]); // one welcome, both targets
await group.commit([proposeRemoveMember(bobPubkey)]); // self-removal blocked
await group.commit([proposeUpdateMetadata({ name: "New" })]);
```

**Production transport** — `ContextVmTransport` is a thin client over
`@contextvm/sdk` (two `Client`s: authed + ephemeral). It encodes the SDK's domain
types to the `@cordn/core` base64 wire contract; the method→channel routing is
built in, so you never pick a channel per call.

```ts
import { ContextVmTransport } from "@cordn/sdk/extra";

const transport = new ContextVmTransport({
  serverPubkey,
  relayHandler, // ApplesauceRelayPool(relays) in production
  authedSigner: window.nostr, // NIP-07 identity (or hex privkey / NostrSigner)
});
// …later: await transport.disconnect();
```

## API surface

- `CordnClient` → `keyPackages` (`generate`/`publish`/`consume`/`list`/`remove`),
  `groups` (`create`/`joinFromWelcome`/`load`/`previewWelcome`),
  `invites` (`fetch`), `joinRequests` (`fetch`/`store`).
- `CordnGroup` → `send`/`commit`/`fetch`/`runInbox`/`serialize`,
  `status`/`lifecycle`/`poisonedAtCursor`/`fetchCursor`/`lastCursor`.
- `CordnGroupEngine` (`@cordn/sdk/engine`) → transport-agnostic state machine,
  `serialize`/`fromSerialized`, structured `IngestResult` dispositions, named
  `CordnError` hierarchy.

Inboxes (welcomes, join requests) are **primitives, not loops** — the SDK
handles consumed-ref ack and publication binding internally; the app decides
cadence. Group-message sync offers an opt-in `runInbox()` runner **and** raw
`fetch`/`subscribe` primitives.

## Subpath exports

| Subpath              | Contents                                                                              |
| -------------------- | ------------------------------------------------------------------------------------- |
| `@cordn/sdk`         | `CordnClient`, managers, `CordnGroup`, transport/storage seams                        |
| `@cordn/sdk/engine`  | `CordnGroupEngine`, types, errors, member helpers                                     |
| `@cordn/sdk/extra`   | `InMemoryKeyValueStore`, **`ContextVmTransport`** (thin client over `@contextvm/sdk`) |
| `@cordn/sdk/testing` | in-process coordinator transport, `PrivateKeySigner` (dev/test only)                  |
| `@cordn/sdk/mls`     | re-exports `ts-mls`                                                                   |

`@cordn/coordinator` is a **devDependency** — clients never embed it; the
in-process transport is test-only.
