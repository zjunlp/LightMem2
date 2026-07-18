# Configuration Model

::: warning Under development
The formal configuration model is being defined by the core team. This page describes the current working model.
:::

LightMem2 uses a **layered configuration model** where settings cascade from broad defaults to specific overrides. Each layer overrides the previous one.

## Configuration Layers

```text
┌─────────────────────────────────┐
│  4. User overrides              │  ← Highest priority
│     (CLI flags, env vars)       │
├─────────────────────────────────┤
│  3. Plugin-level config         │
│     (plugin's own settings)     │
├─────────────────────────────────┤
│  2. Host-level config           │
│     (host's native config file) │
├─────────────────────────────────┤
│  1. Platform defaults           │  ← Lowest priority
│     (built-in sensible defaults)│
└─────────────────────────────────┘
```

## Where Configuration Lives

| Host | Config File | Plugin Config |
| :-- | :-- | :-- |
| OpenClaw | `~/.openclaw/openclaw.json` | Inside the host config |
| Codex | `~/.codex/tokenpilot.json` | Separate plugin config file |
| Claude Code | `~/.claude/tokenpilot.json` | Separate plugin config file |

## Common Plugin Settings

These settings exist for all plugins:

```json
{
  "enabled": true,
  "mode": "normal",
  "logLevel": "info"
}
```

TokenPilot adds its own settings (see [TokenPilot Configuration](/plugin-catalog/tokenpilot/configuration)).

## Environment Variables

Adapters use environment variables for non-default paths:

| Variable | Purpose | Host |
| :-- | :-- | :-- |
| `LIGHTMEM2_OPENCLAW_HOME` | Custom OpenClaw home dir | OpenClaw |
| `OPENCLAW_CONFIG_PATH` | Custom config path | OpenClaw |
| `CODEX_CONFIG_PATH` | Custom config.toml path | Codex |
| `CODEX_HOOKS_CONFIG_PATH` | Custom hooks.json path | Codex |
| `TOKENPILOT_CODEX_CONFIG` | Custom tokenpilot.json path | Codex |
| `CLAUDE_CODE_SETTINGS_PATH` | Custom settings.json path | Claude Code |
| `CLAUDE_CODE_MCP_CONFIG_PATH` | Custom .claude.json path | Claude Code |
| `TOKENPILOT_CLAUDE_CODE_CONFIG` | Custom tokenpilot.json path | Claude Code |

## Resolving Configuration

At runtime, LightMem2:

1. Reads platform defaults
2. Reads the host config file
3. Reads the plugin config file
4. Applies environment variable overrides
5. Applies CLI flag overrides

The resolved config is what plugins see at runtime.

## Next

- [TokenPilot Configuration](/plugin-catalog/tokenpilot/configuration) — TokenPilot-specific settings
- [Plugin Configuration](/user-guide/plugin-configuration) — how to change plugin settings
