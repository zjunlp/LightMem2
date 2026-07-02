# TokenPilot Codex Adapter

This package contains the current Codex CLI adapter for the TokenPilot component.
It integrates through Codex config mutation, hook registration, and a local OpenAI-compatible Responses proxy.

For the component-level overview and shared command surface, see:

- [`components/tokenpilot/README.md`](../../README.md)
- [`components/tokenpilot/adapters/README.md`](../README.md)
- [`components/tokenpilot/HOSTS.md`](../../HOSTS.md)

## Supports

The Codex adapter is intentionally narrower than the OpenClaw adapter.

Supported:

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
- local read-only Codex skill bridge for `status` / `report` / `doctor` / `visual`

Current limitations:

- visual inspector payload parity
- lifecycle-aware eviction controls
- `mode aggressive`
- native runtime-managed in-host commands

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

- keep the current active `model_provider`
- repoint that active provider's `base_url` to the local TokenPilot proxy
- persist the original upstream provider config into `~/.codex/tokenpilot.json`
- register a `tokenpilot_memory_fault_recover` MCP server in Codex config
- write a conservative `startup_timeout_sec` for the recovery MCP server
- write TokenPilot runtime config
- register TokenPilot hooks for `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop`
- install read-only Codex skill bridge entries under the local Codex skills directory
- run a post-install MCP startup probe and report degraded mode if recovery MCP is still unavailable

The installed Codex skill bridge currently creates these explicit skills:

- `lightmem2-status`
- `lightmem2-report`
- `lightmem2-doctor`
- `lightmem2-visual`

These are host entry points, not a separate runtime implementation. They call
the existing `lightmem2 codex ...` CLI surface underneath.

This install mode is intentionally session-preserving: Codex keeps using the
same provider name it was already using, so existing thread history does not
disappear behind a separate `tokenpilot` provider bucket.

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

If install finishes in degraded MCP mode, Codex stable-prefix and reduction remain usable; only the real `memory_fault_recover` tool path is unavailable until MCP startup succeeds.

For daemon-level checks:

```bash
tokenpilot-codex status
tokenpilot-codex start
tokenpilot-codex stop
```

## Commands

Codex command surface:

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

Supported reduction passes:

- `readStateCompaction`
- `toolPayloadTrim`
- `htmlSlimming`
- `execOutputTruncation`
- `agentsStartupOptimization`

Not supported:

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
rg "model_provider|base_url" ~/.codex/config.toml
rg "mcp_servers.tokenpilot_memory_fault_recover" ~/.codex/config.toml
npm --prefix components/tokenpilot/adapters/codex run doctor:codex
tokenpilot-codex status
```

Expected install shape:

- root `model_provider` stays on your original Codex provider, such as `OPENAI`
- that provider's `base_url` is rewritten to `http://127.0.0.1:<port>/v1`
- the real upstream base URL is stored in `~/.codex/tokenpilot.json`

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
