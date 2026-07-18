# Logs and Diagnostics

How to find logs, understand diagnostic output, and collect information for bug reports.

## Quick Diagnostic Commands

Always start with these three:

```bash
lightmem2 doctor    # Integration health check
lightmem2 status    # Current state
lightmem2 report    # Session metrics
```

These answer 90% of "is it working?" questions.

## Log Locations

| Host | Log Location | Notes |
| :-- | :-- | :-- |
| OpenClaw | OpenClaw's own logs | TokenPilot runs inside OpenClaw process |
| Codex | `~/.codex/logs/` | Proxy and hook logs |
| Claude Code | `~/.claude/logs/` | Gateway logs |

## Understanding Doctor Output

```text
plugin entry enabled:   yes    ← Plugin is registered with the host
config enabled:          yes    ← Plugin config is readable and valid
mode:                    normal ← Current runtime mode
stabilizer enabled:      yes    ← Stable prefix is active
reduction enabled:       yes    ← Context reduction is active
proxy healthy:           yes    ← (Codex/Claude Code) Local proxy is running
config file readable:    yes    ← Config file exists and is valid JSON
backup files present:    yes    ← .tokenpilot.bak backups exist for recovery
```

A `yes` in every field = TokenPilot is fully operational.

## Understanding Status Output

```text
plugin entry:  enabled
config:        enabled
mode:          normal
stabilizer:    enabled
reduction:     enabled (balanced)
eviction:      enabled
```

This is the lightweight version of `doctor` — fast, always available, and sufficient for daily use.

## Collecting Info for Bug Reports

When [reporting a bug](/plugin-catalog/tokenpilot/troubleshooting#reporting-a-bug), include:

```bash
# Run these and save the output
lightmem2 doctor > doctor.txt 2>&1
lightmem2 status > status.txt 2>&1
lightmem2 report > report.txt 2>&1

# Also note:
# - Your OS and version
# - Your host and version
# - Any custom config paths (env vars set)
# - What you expected to happen
# - What actually happened
```

## Next

- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — common problems and solutions
- [Uninstall and Rollback](/user-guide/uninstall-and-rollback) — clean removal
