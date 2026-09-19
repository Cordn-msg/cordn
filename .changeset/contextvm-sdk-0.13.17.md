---
"@cordn/cli": patch
"@cordn/core": patch
---

Upgrade `@contextvm/sdk` to 0.13.17 across all workspace packages and unify zod at 4.6.5 so a single `@contextvm/mcp-sdk` instance is resolved (fixes `Client` type mismatch between the SDK transport and the CLI's MCP client).
