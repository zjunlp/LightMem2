# TokenPilot Overview

TokenPilot is the first official LightMem2 plugin. It is a **cache-aware context runtime** that reduces token usage and cost in long-running agent sessions.

## What TokenPilot Does

Agent sessions grow. Every turn adds more messages, more tool outputs, more context. The model sees all of it, and you pay for all of it. Much of that context is repetitive — identical prefixes sent every turn, bloated tool outputs, stale history.

TokenPilot addresses this with three techniques:

```text
┌─────────────────────────────────────────────────────┐
│                 TokenPilot Pipeline                   │
├─────────────────────────────────────────────────────┤
│  1. Stable Prefix                                    │
│     Rewrites context into cache-stable form           │
│     → Higher cache hit rate                          │
├─────────────────────────────────────────────────────┤
│  2. Context Reduction                                │
│     Trims oversized tool output before it pollutes   │
│     → Leaner context per turn                        │
├─────────────────────────────────────────────────────┤
│  3. Context Eviction                                 │
│     Limits how much old context is carried forward   │
│     → Sessions don't grow unbounded                  │
└─────────────────────────────────────────────────────┘
```

## Key Results

From the [TokenPilot paper](https://arxiv.org/abs/2606.17016), evaluated on PinchBench and Claw-Eval benchmarks (continuous mode):

| Metric | PinchBench | Claw-Eval |
| :-- | --: | --: |
| Input token reduction | **67.4%** | **95.7%** |
| Cost reduction | **61.5%** | **87.0%** |
| Cache read (M tokens) | 8.55 vs. 25.02 (Vanilla) | 21.43 vs. 709.85 (Vanilla) |

See [Benchmarks](/plugin-catalog/tokenpilot/benchmarks) for full results.

## Supported Hosts

TokenPilot works on three agent hosts, each with a different integration style:

| Host | Integration | Page |
| :-- | :-- | :-- |
| OpenClaw | Native plugin slot | [OpenClaw](/hosts/openclaw) |
| Codex CLI | Local proxy + hooks | [Codex](/hosts/codex) |
| Claude Code | Local gateway + MCP | [Claude Code](/hosts/claude-code) |

Features are consistent across hosts. Differences are documented on each host page.

## Quick Tour

- [Installation](/plugin-catalog/tokenpilot/installation) — get TokenPilot running
- [Configuration](/plugin-catalog/tokenpilot/configuration) — settings and defaults
- [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) — conservative, normal, aggressive
- [Benchmarks](/plugin-catalog/tokenpilot/benchmarks) — evaluation results
- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — common problems and fixes
