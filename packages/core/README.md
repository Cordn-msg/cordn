# @cordn/core

Shared foundation for **cordn** — the TypeScript MLS delivery service and
ContextVM server adapter.

`@cordn/core` provides the transport-agnostic building blocks shared across the
cordn packages:

- **wire contracts** — zod schemas, inferred types, and method names
- **leaf codecs** — base64, MLS framing, the last-resort key-package extension,
  and the bech32 `cordn1…` group reference (`encodeGroupRef` / `decodeGroupRef`)
- **consumed-ref** value types

See the
[group-ref spec](https://github.com/Cordn-msg/cordn/tree/master/spec/applications/group-ref.md)
for the `cordn1…` encoding.

## Install

```sh
npm install @cordn/core
```

## License

MIT
