# TokenPilot Claude Code Adapter

This package contains the current Claude Code adapter for the TokenPilot
component. It is gateway-first: Claude Code requests are routed through a local
Anthropic-compatible gateway, while hooks and a shared MCP server provide
observability and real archive recovery.

This adapter explicitly binds the TokenPilot `stabilizer` and `reduction`
features. It does not advertise lifecycle eviction support. Its product
registration provides Claude Code state discovery to the shared CLI and Visual
surface.

For the shared component overview and host matrix, see:

- [`components/presets/tokenpilot/README.md`](../../presets/tokenpilot/README.md)
- [`components/adapters/HOSTS.md`](../HOSTS.md)
- [`components/adapters/README.md`](../README.md)

## Supports

Supported:

- Claude Code install into local settings and MCP config
- TokenPilot runtime config in `~/.claude/tokenpilot.json`
- local gateway routing through an Anthropic-compatible adapter surface
- real MCP-backed `memory_fault_recover`
- lightweight observability hooks
- stable-prefix rewriting
- request-time reduction
- lightweight session-state and ux-effects tracking
- shared browser visual via `lightmem2 claude-code visual`
- standalone `lightmem2 claude-code ...` command surface
- local read-only Claude Code skill bridge for `status` / `report` / `doctor` / `visual`

Current limitations:

- lifecycle eviction controls
- `mode aggressive`
- native runtime-managed in-host commands
- browser visual parity

## Install

Build the adapter:

```bash
cd /path/to/LightMem2
npm --prefix components/adapters/claude-code run build
```

If your Claude Code files are not under the default `~/.claude`, set:

```bash
export CLAUDE_CODE_SETTINGS_PATH="/path/to/settings.json"
export CLAUDE_CODE_MCP_CONFIG_PATH="/path/to/.claude.json"
export TOKENPILOT_CLAUDE_CODE_CONFIG="/path/to/tokenpilot.json"
```

Then install:

```bash
cd /path/to/LightMem2
npm --prefix components/adapters/claude-code run install:claude-code
```

If `lightmem2` is not found after install, make sure `~/.local/bin` is on your `PATH`.

The installer will:

- update `~/.claude/settings.json` for local gateway routing
- enable the required tool-search environment flag
- write TokenPilot runtime config to `~/.claude/tokenpilot.json`
- register the shared `tokenpilot_memory_fault_recover` MCP server in `~/.claude/.claude.json`
- install a `SessionStart` hook that auto-starts the local TokenPilot gateway on first use
- install read-only Claude Code skill bridge entries under the local Claude skills directory
- preserve existing Claude files as `.tokenpilot.bak` backups before rewriting
- write a conservative `startup_timeout_sec` for the recovery MCP server
- run a post-install MCP startup probe and report degraded mode if recovery MCP is still unavailable

The installed Claude Code skill bridge currently creates these explicit skills:

- `lightmem2-status`
- `lightmem2-report`
- `lightmem2-doctor`
- `lightmem2-visual`

These are host entry points, not a separate runtime implementation. They call
the existing `lightmem2 claude-code ...` CLI surface underneath.

## Verify

You can run the adapter doctor immediately after install:

```bash
cd /path/to/LightMem2
npm --prefix components/adapters/claude-code run doctor:claude-code
```

Then use the first real-session path:

1. Start Claude Code normally.
2. Open a new Claude Code session so `SessionStart` can auto-start the local gateway.
3. In another terminal, verify through the shared CLI:

```bash
lightmem2 claude-code status
lightmem2 claude-code doctor
lightmem2 claude-code report
lightmem2 claude-code mode normal
lightmem2 claude-code reduction status
lightmem2 claude-code stabilizer target developer
```

The Claude Code gateway is now auto-started from the installed `SessionStart`
hook. After the first Claude Code session starts, `lightmem2 claude-code doctor`
should report `proxy healthy: yes` without a separate manual start step.

Expected first-run shape:

- `lightmem2 claude-code doctor` reports `proxy healthy: yes`
- `lightmem2 claude-code status` shows `stabilizer` and `reduction` enabled
- after a few turns, `lightmem2 claude-code report` no longer says `No TokenPilot session stats yet.`

Claude Code currently supports `mode conservative` and `mode normal`.
`mode aggressive` is not available on the current adapter.

## Commands

Claude Code command surface:

```bash
lightmem2 claude-code status
lightmem2 claude-code report
lightmem2 claude-code doctor
lightmem2 claude-code visual
lightmem2 claude-code mode conservative
lightmem2 claude-code mode normal
lightmem2 claude-code stabilizer on
lightmem2 claude-code stabilizer off
lightmem2 claude-code stabilizer target developer
lightmem2 claude-code stabilizer target user
lightmem2 claude-code reduction on
lightmem2 claude-code reduction off
lightmem2 claude-code reduction mode light
lightmem2 claude-code reduction mode balanced
lightmem2 claude-code reduction pass toolPayloadTrim off
```

Supported reduction passes:

- `readStateCompaction`
- `toolPayloadTrim`
- `htmlSlimming`
- `execOutputTruncation`
- `agentsStartupOptimization`

Not supported:

- `lightmem2 claude-code settings ...`
- `lightmem2 claude-code eviction ...`
- `lightmem2 claude-code mode aggressive`
- `lightmem2 claude-code stabilizer hook ...`

## Doctor Coverage

Doctor checks report whether:

- Claude settings are installed
- observability hooks are installed
- observability hooks are complete or only partially installed
- observability hooks still point to the expected current handler command
- gateway routing is active
- tool search is enabled
- recovery MCP is installed
- MCP `TOKENPILOT_STATE_DIR` matches the TokenPilot config state dir
- MCP command / args still match the current TokenPilot install
- MCP startup timeout still matches the expected install value
- proxy health is reachable
- session-state / ux-effects data already exist

## Report And Visual

`lightmem2 claude-code report` and `lightmem2 claude-code visual` intentionally serve different purposes:

- `report`
  - savings-oriented summary from `ux-effects`
- `visual`
  - shared browser visual surface preselected to the current Claude Code host and session

Current visual data includes:

- stability snapshots
- reduction snapshots
- recent cache-audit summaries
- browser-side host and session selection through the shared visual surface

Claude Code still persists lightweight observability state from gateway + hooks, but `lightmem2 claude-code visual` now opens the shared browser visual surface rather than a text-only view.

## Runtime Files

The current adapter writes state under:

```text
~/.claude/tokenpilot-state/tokenpilot/
```

Useful files:

- `event-trace.jsonl`
- `session-state/latest.json`
- `session-state/sessions/<session>.json`
- `session-state/bindings/<session>.jsonl`
- `ux-effects/latest.json`
- `ux-effects/sessions/<session>.json`

## Debugging

Useful checks:

```bash
cat ~/.claude/tokenpilot.json
cat ~/.claude/settings.json
cat ~/.claude/.claude.json
npm --prefix components/adapters/claude-code run doctor:claude-code
```

If install finishes in degraded MCP mode, gateway routing and reduction remain
usable; only the real `memory_fault_recover` tool path is unavailable until MCP
startup succeeds.

## Package Scripts

Primary package scripts:

```bash
npm --prefix components/adapters/claude-code run build
npm --prefix components/adapters/claude-code run typecheck
npm --prefix components/adapters/claude-code test
npm --prefix components/adapters/claude-code run install:claude-code
npm --prefix components/adapters/claude-code run doctor:claude-code
```
