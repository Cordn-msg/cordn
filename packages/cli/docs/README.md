# Cordn CLI documentation

`cordn` is a persistent MLS client for interactive use, scripts, and local agent integrations.

## Bundled defaults

A fresh client connects to:

- coordinator: `92753cbe63e943d0c4a0c61d745437892af6e98f179ce04a7a863aad4e00b1a5`
- relays: `wss://relay.contextvm.org`, `wss://relay2.contextvm.org`, `wss://relay.primal.net`

Override them with `--server-pubkey` and one or more `--relay` options. A persistent state snapshot remembers the coordinator and relays used to create it.

## Topics

```sh
cordn docs quickstart  # installation and first group
cordn docs commands    # complete REPL and one-shot command reference
cordn docs agent       # safe non-interactive and agent usage
cordn docs daemon      # daemon lifecycle and recovery
cordn docs queues      # inbox/outbox schemas and atomic file protocol
cordn docs security    # identity, state, permissions, and trust boundaries
```

All documentation is bundled with the installed CLI and matches its version. Run `cordn --help` for startup options and start the interactive REPL with `cordn --state-file <path>` for its command list.
