# Plugin Directory Structure

::: danger 
 `components/tokenpilot/`  README 
:::

## 

```text
components/tokenpilot/
 adapters/               # Host-specific integration
    openclaw/
    codex/
    claude-code/
 products/
    cli/                # Shared CLI
    mcp/                # Shared MCP server
 packages/
     host-adapter/       # Shared adapter contracts
     runtime-core/       # Runtime engine
     kernel/             # Shared types and interfaces
     layers/
         history/
         decision/
         memory/         # Experimental
```

 Plugin Directory Structure 
