# What is LightMem2

LightMem2 is an **open plugin platform for long-running AI agents**. It lets you build agent capabilities once and run them across multiple agent hosts — OpenClaw, Codex, Claude Code, and future hosts.

## LightMem2 vs. TokenPilot

A common point of confusion: LightMem2 and TokenPilot are not the same thing.

| | LightMem2 | TokenPilot |
| :-- | :-- | :-- |
| **What it is** | A plugin platform and runtime | A plugin that runs on LightMem2 |
| **Role** | Loads, manages, and executes plugins | Provides cache-aware context management |
| **Scope** | Platform-wide: plugins, adapters, CLI | One specific capability: reducing token usage |
| **Status** | Active development | Stable — the first official plugin |

Think of LightMem2 as the operating system and TokenPilot as an app that runs on it.

## What Problems It Solves

- **Long sessions get expensive**. As agent sessions grow, every turn carries more context, which means more tokens and higher costs.
- **Context is repetitive**. Much of what gets sent to the model each turn is identical to the previous turn — wasteful if not cached.
- **Tool output is noisy**. Large tool responses can pollute future turns with irrelevant data.
- **Sessions don't prune themselves**. Without eviction, old context accumulates until sessions hit limits or become too slow.

LightMem2 addresses these through its plugin model. TokenPilot, the first plugin, implements the runtime policies: stable-prefix rewriting, context reduction, and lifecycle-aware eviction.

## What It Doesn't Solve

- **Short, single-turn interactions**. If your sessions are always one-shot, there is nothing for caching or eviction to optimize.
- **Model quality or accuracy**. LightMem2 doesn't change model behavior — it changes what context gets sent to the model.
- **All memory problems**. Long-term memory is an experimental feature area; TokenPilot focuses on the current session's context window.

## Relationship to the Paper

The [TokenPilot paper](https://arxiv.org/abs/2606.17016) describes the cache-efficient context management technique. LightMem2 is the platform that hosts TokenPilot as its first plugin, and will host additional plugins in the future.

## Next Steps

- [Quick Start](/getting-started/quick-start) — get running in under 5 minutes
- [Core Concepts](/platform-concepts/core-runtime) — understand the platform architecture
- [TokenPilot Overview](/plugin-catalog/tokenpilot/overview) — dive into the featured plugin
