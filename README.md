# EcoClaw: Resource-Efficient Execution for Language Model Agents

A pluggable context operating system for language model agents:

- Prompt cache orchestration (OpenAI/Anthropic aware)
- Idle summarization and context rehydration
- Tool output compression and token budgeting
- Retrieval hooks (QMD-style / memory search)
- Task-aware subagent routing

## Design Choice: Single Session First

This repository implements **single-session runtime behavior first** for safety and fast iteration.
Cross-session reuse is represented by explicit interfaces (`MemoryGraph`, `PromptProfileManager`) and can be enabled later without breaking module APIs.

This avoids coupling cache stability to evolving cross-session memory too early.

## Package Layout

- `packages/kernel`: pipeline, contracts, event bus
- `packages/layers/data`: memory-state + retrieval layer
- `packages/layers/decision`: policy + task-router + decision-ledger layer
- `packages/layers/execution`: cache + summary + compression layer
- `packages/layers/orchestration`: OpenClaw runtime orchestration connector
- `packages/providers/*`: provider-specific cache + usage adapters
- `packages/storage/fs`: filesystem-backed runtime state store
- `packages/observability`: metrics sink primitives
- `apps/lab-bench`: replay + A/B harness scaffold

## OpenClaw Plugin (WIP)

Target plug-and-play flow:

```bash
openclaw plugins install ecoclaw
openclaw gateway restart
```

The plugin package lives at `packages/openclaw-plugin` and is designed to be
published as npm package `ecoclaw`.
