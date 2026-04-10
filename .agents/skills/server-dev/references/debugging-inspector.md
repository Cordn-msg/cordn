# Debugging with MCP Inspector

Use the MCP Inspector to validate your MCP server implementation in isolation.

Why this helps for ContextVM servers:

- Lets you quickly test `tools/list`, `tools/call`, `resources/list`, `resources/read`, and prompts.
- Surfaces schema issues early (input validation, missing fields, bad JSON-RPC shapes).

## Install / run

The Inspector runs via `npx` (no global install needed):

```bash
npx @modelcontextprotocol/inspector <command>
```

## Recommended workflow

1. Start your MCP server using a local transport (commonly STDIO).
2. Launch the Inspector pointing at the same command you use to start the server.
3. Use the Inspector UI to:
   - Connect
   - List tools/resources/prompts
   - Execute a tool with test input
   - Inspect errors and notifications
4. Iterate until the MCP surface area is correct.
5. Switch the server transport to `NostrServerTransport` for ContextVM.

## Common pitfalls

### Logging to stdout (STDIO servers)

If your server uses STDIO transport, avoid writing logs to stdout (it can corrupt the JSON-RPC stream). Prefer stderr.

### Schema drift

If a client (or ctxcn) relies on tool schemas, treat schemas as part of the public contract:

- Keep `inputSchema` accurate.
- Prefer stable tool names.
- Return structured output consistently.

## References

- Inspector repo: https://github.com/modelcontextprotocol/inspector
