# Repository Structure

The LightMem2 repository is organized around the plugin platform and its components.

```text
LightMem2/
├── components/
│   └── tokenpilot/              # TokenPilot plugin
│       ├── adapters/            # Host-specific integration
│       │   ├── openclaw/        #   OpenClaw native plugin adapter
│       │   ├── codex/           #   Codex CLI proxy + hooks adapter
│       │   └── claude-code/     #   Claude Code gateway + MCP adapter
│       ├── products/
│       │   ├── cli/             #   Shared lightmem2 CLI
│       │   └── mcp/             #   Shared MCP recovery server
│       └── packages/
│           ├── host-adapter/    #   Shared adapter contracts
│           ├── runtime-core/    #   Host-agnostic runtime engine
│           ├── kernel/          #   Shared types, interfaces, events
│           └── layers/
│               ├── history/     #   Canonical state, turns, task registry
│               ├── decision/    #   Policy analysis, reduction/eviction
│               └── memory/      #   Experimental memory layer
├── docs/                        # Public-facing notes and helpers
├── experiments/                 # Benchmark adapters and scripts
├── website/                     # This documentation site
├── figs/                        # Images for README
└── README.md
```

## Key Directories

| Directory | Purpose |
| :-- | :-- |
| `components/tokenpilot/packages/kernel/` | Types, interfaces, events — the contract layer |
| `components/tokenpilot/packages/runtime-core/` | Plugin execution engine |
| `components/tokenpilot/packages/layers/` | Stateful processing (history, decision, memory) |
| `components/tokenpilot/adapters/` | One adapter per host |
| `components/tokenpilot/products/cli/` | The `lightmem2` CLI |
| `components/tokenpilot/products/mcp/` | Shared MCP server |

## Workspace

The repository uses pnpm workspaces. See `pnpm-workspace.yaml` for the full list.

## Next

- [Local Development](/development/local-development)
- [Build and Test](/development/build-and-test)
- [Contributing](/development/contributing)
