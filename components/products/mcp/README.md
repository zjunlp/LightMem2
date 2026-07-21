# TokenPilot Recovery MCP Product

This package provides the host-neutral `memory_fault_recover` MCP server used
by Codex and Claude Code adapters.

The server declares its TokenPilot preset ownership through a shared
`ProductRegistration`. It does not register as a host because it only resolves
archived artifacts from a supplied `TOKENPILOT_STATE_DIR`.

The package root resolver targets the reorganized source location:
`components/products/mcp`. Installed host configurations should point at the
built `dist/server.js` entry.

```bash
pnpm --dir components/products/mcp build
pnpm --dir components/products/mcp typecheck
pnpm --dir components/products/mcp test
```
