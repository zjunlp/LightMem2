# TokenPilot Codex Adapter

This package contains the current Codex CLI adapter for the TokenPilot component.
It integrates through Codex config mutation, hook registration, and a local OpenAI-compatible Responses proxy.

For the component-level overview and shared command surface, see:

- [`components/tokenpilot/README.md`](../../README.md)
- [`components/tokenpilot/adapters/README.md`](../README.md)
- [`components/tokenpilot/HOSTS.md`](../../HOSTS.md)

## Current Scope

The current Codex adapter is intentionally narrower than the OpenClaw adapter.

Implemented today:

- Codex provider installation into `config.toml`
- TokenPilot runtime config in `~/.codex/tokenpilot.json`
- Codex hook registration in `~/.codex/hooks.json`
- recovery MCP registration for real `memory_fault_recover`
- local Responses proxy lifecycle
- stable-prefix rewriting
- request-time reduction
- lightweight session-state tracking from proxy + hooks
- text-mode Codex session visual via `lightmem2 codex visual`
- standalone `lightmem2 codex ...` command surface

Not fully matched with OpenClaw yet:

- visual inspector payload parity
- lifecycle-aware eviction controls
- `mode aggressive`
- native in-host slash commands

## Install

Build the adapter:

```bash
cd /path/to/LightMem2
npm --prefix components/tokenpilot/adapters/codex run build
```

If your Codex files are not under the default `~/.codex`, set:

```bash
export CODEX_CONFIG_PATH="/path/to/config.toml"
export CODEX_HOOKS_CONFIG_PATH="/path/to/hooks.json"
export TOKENPILOT_CODEX_CONFIG="/path/to/tokenpilot.json"
```

Then install:

```bash
cd /path/to/LightMem2
npm --prefix components/tokenpilot/adapters/codex run install:codex
```

The installer will:

- add a TokenPilot provider entry to Codex config
- switch the default `model_provider` to that TokenPilot provider
- register a `tokenpilot_memory_fault_recover` MCP server in Codex config
- write TokenPilot runtime config
- register TokenPilot hooks for `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop`

## Verify

First, run the adapter doctor:

```bash
cd /path/to/LightMem2
npm --prefix components/tokenpilot/adapters/codex run doctor:codex
```

Then verify through the shared CLI:

```bash
lightmem2 codex status
lightmem2 codex doctor
lightmem2 codex mode normal
lightmem2 codex reduction status
```

Once installed, Codex can use the real internal recovery tool named
`memory_fault_recover` through the registered MCP server. Recovery hints in
trimmed payloads are no longer just protocol text.

For daemon-level checks:

```bash
tokenpilot-codex status
tokenpilot-codex start
tokenpilot-codex stop
```

## Supported Commands

Current Codex command surface:

```bash
lightmem2 codex status
lightmem2 codex report
lightmem2 codex doctor
lightmem2 codex visual
lightmem2 codex mode conservative
lightmem2 codex mode normal
lightmem2 codex stabilizer on
lightmem2 codex stabilizer off
lightmem2 codex stabilizer target developer
lightmem2 codex stabilizer target user
lightmem2 codex reduction on
lightmem2 codex reduction off
lightmem2 codex reduction mode light
lightmem2 codex reduction mode balanced
lightmem2 codex reduction pass toolPayloadTrim off
```

Supported reduction passes are currently limited to:

- `readStateCompaction`
- `toolPayloadTrim`
- `htmlSlimming`
- `execOutputTruncation`
- `agentsStartupOptimization`

Unsupported today:

- `lightmem2 codex settings ...`
- `lightmem2 codex eviction ...`
- `lightmem2 codex mode aggressive`
- `lightmem2 codex stabilizer hook ...`

## Report And Visual

`lightmem2 codex report` and `lightmem2 codex visual` intentionally serve different purposes:

- `report`: savings-oriented summary from `ux-effects`
- `visual`: text-mode session topology and recent-turn view from Codex proxy + hook traces

Current `visual` output includes:

- latest resolved session id
- latest / previous response ids when available
- recent response chain
- workspace hint
- last observed hook and tool
- recent turn request / response / assistant char counts

This is a lightweight observability layer for Codex. It is not yet the same browser visual surface used by the OpenClaw adapter.

## Runtime Files

The current adapter writes state under:

```text
~/.codex/tokenpilot-state/tokenpilot/
```

Useful files:

- `tokenpilot-codex.pid`
- `tokenpilot-codex.log`
- `event-trace.jsonl`
- `session-state/latest.json`
- `session-state/sessions/<session>.json`
- `session-state/bindings/<session>.jsonl`
- `ux-effects/latest.json`
- `ux-effects/sessions/<session>.json`

## Debugging

Useful checks:

```bash
cat ~/.codex/tokenpilot.json
cat ~/.codex/hooks.json
rg "model_provider|model_providers.tokenpilot" ~/.codex/config.toml
rg "mcp_servers.tokenpilot_memory_fault_recover" ~/.codex/config.toml
npm --prefix components/tokenpilot/adapters/codex run doctor:codex
tokenpilot-codex status
```

If Codex reports that hooks need review, trust the TokenPilot hooks in Codex and rerun the doctor.

## Package Scripts

Primary package scripts:

```bash
npm --prefix components/tokenpilot/adapters/codex run build
npm --prefix components/tokenpilot/adapters/codex run typecheck
npm --prefix components/tokenpilot/adapters/codex test
npm --prefix components/tokenpilot/adapters/codex run install:codex
npm --prefix components/tokenpilot/adapters/codex run doctor:codex
```
