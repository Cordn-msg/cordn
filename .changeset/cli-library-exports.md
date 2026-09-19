---
"@cordn/cli": minor
---

Expose the Node client as an importable library: `import { CliSession, openPersistentSession, ... } from "@cordn/cli"`, with typed `dist/lib/**` output published alongside the `cordn` executable. The daemon's persistent-session wiring (state lock, snapshot restore, serialized durable writes) moved into `openPersistentSession` and is shared by the CLI.
