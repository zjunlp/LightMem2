# Claude Code

Claude Code integration uses a **local gateway + MCP** pattern. TokenPilot runs as a local Anthropic-compatible gateway that Claude Code routes through.

::: info Test Environment
**OS**: macOS 14 / Linux (Ubuntu 22.04) &nbsp;|&nbsp; **Node**: v20+ &nbsp;|&nbsp; **Last verified**: 2026-07-16
:::

## Installation

```bash
npm --prefix components/adapters/claude-code run build
npm --prefix components/adapters/claude-code run install:claude-code
```

This command:
- Updates `~/.claude/settings.json` for local gateway routing
- Writes `~/.claude/tokenpilot.json`
- Registers the shared `tokenpilot_memory_fault_recover` MCP server in `~/.claude/.claude.json`
- Installs a `SessionStart` hook that auto-starts the local gateway on first use
- Preserves existing Claude files as `.tokenpilot.bak` backups

### Custom Paths

```bash
export CLAUDE_CODE_SETTINGS_PATH="/path/to/settings.json"
export CLAUDE_CODE_MCP_CONFIG_PATH="/path/to/.claude.json"
export TOKENPILOT_CLAUDE_CODE_CONFIG="/path/to/tokenpilot.json"
npm --prefix components/adapters/claude-code run build
npm --prefix components/adapters/claude-code run install:claude-code
```

## Expected Output

After install, these files are created or modified:

| File | Purpose |
| :-- | :-- |
| `~/.claude/settings.json` | Local gateway routing configuration |
| `~/.claude/tokenpilot.json` | TokenPilot plugin configuration |
| `~/.claude/.claude.json` | MCP server registration |
| Config backups | `*.tokenpilot.bak` alongside originals |

## Verification

```bash
lightmem2 claude-code status
lightmem2 claude-code doctor
```

Expected output:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `stabilizer enabled`
- `reduction enabled`
- `proxy healthy: yes`

## First Run

1. Start Claude Code normally
2. Open a **new session** so `SessionStart` can auto-start the local gateway
3. In another terminal, verify:

```bash
lightmem2 claude-code doctor
```

::: warning Gateway starts on first session
Install success does not guarantee the gateway is already healthy before `SessionStart` fires. Open a new Claude Code session to trigger auto-start.
:::

## Standalone CLI

All commands use the standalone CLI:

```bash
lightmem2 claude-code status
lightmem2 claude-code report
lightmem2 claude-code doctor
lightmem2 claude-code visual
lightmem2 claude-code session <session-id> report
lightmem2 claude-code reduction status
lightmem2 claude-code stabilizer target developer
lightmem2 claude-code mode normal
lightmem2 claude-code reduction mode balanced
lightmem2 claude-code help
```

## Useful Controls

| Command | Effect |
| :-- | :-- |
| `stabilizer on\|off` | Toggle stable-prefix rewriting |
| `stabilizer target <developer\|user>` | Choose where dynamic context is attached |
| `reduction on\|off` | Toggle observation reduction |
| `reduction mode <light\|balanced>` | Switch between lighter and stronger trimming |
| `reduction pass toolPayloadTrim off` | Disable one specific reduction pass |

## PATH Setup

If `lightmem2` is not found after install:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add to `~/.bashrc` or `~/.zshrc` to make permanent.

## Failure Recovery

```bash
# Restore original configs
cp ~/.claude/settings.json.tokenpilot.bak ~/.claude/settings.json
cp ~/.claude/.claude.json.tokenpilot.bak ~/.claude/.claude.json
rm ~/.claude/tokenpilot.json
```

## Troubleshooting

See [TokenPilot Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting#claude-code) for Claude Code-specific issues.
