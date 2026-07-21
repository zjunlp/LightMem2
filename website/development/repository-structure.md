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
│       ├── presets/
│       │   └── tokenpilot/      #   TokenPilot feature composition policy
│       └── packages/
│           ├── foundation/      #   Shared contracts and infrastructure
│           │   ├── kernel/
│           │   ├── runtime-core/
│           │   ├── host-adapter/
│           │   ├── history/
│           │   ├── artifact-store/
│           │   └── product-surface/
│           └── features/        #   Independently testable capabilities
│               ├── stabilizer/
│               ├── reduction/
│               ├── eviction/
│               └── memory/
├── docs/                        # Public-facing notes and helpers
├── experiments/                 # Benchmark adapters and scripts
├── website/                     # This documentation site
├── figs/                        # Images for README
└── README.md
```

## Key Directories

| Directory | Purpose |
| :-- | :-- |
| `components/packages/foundation/kernel/` | Types, interfaces, events — the contract layer |
| `components/packages/foundation/runtime-core/` | Plugin execution engine |
| `components/packages/foundation/` | Shared host, history, artifact, and product infrastructure |
| `components/packages/features/` | Stabilizer, Reduction, Eviction, and Memory capabilities |
| `components/presets/tokenpilot/` | TokenPilot policy and feature composition |
| `components/adapters/` | One adapter per host |
| `components/products/cli/` | The `lightmem2` CLI |
| `components/products/mcp/` | Shared MCP server |

## Workspace

The repository uses pnpm workspaces. See `pnpm-workspace.yaml` for the full list.

## Next

- [Local Development](/development/local-development)
- [Build and Test](/development/build-and-test)
- [Contributing](/development/contributing)
