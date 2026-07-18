# Stable Prefix

The stable prefix is TokenPilot's primary mechanism for improving **cache hit rates** in long-running agent sessions.

## The Problem

Every turn in an agent session, the full conversation history is sent to the model. Most of that context is **identical** from turn to turn — system prompts, tool definitions, earlier messages.

However, even tiny differences in the prefix can cause a **cache miss**, forcing the model to recompute everything. Without stabilization, dynamic content (timestamps, session IDs, variable instructions) gets interleaved with static content, breaking the cache.

## How Stable Prefix Works

TokenPilot separates context into two parts:

1. **Stable prefix**: Everything that doesn't change between turns (system prompts, tool schemas, static instructions)
2. **Dynamic suffix**: What changes each turn (new messages, tool outputs, variable content)

By keeping the stable prefix identical across turns, the model API can reuse the cached computation. Only the dynamic suffix is recomputed.

```text
Turn N:   [ Stable Prefix ] [ Dynamic Content N ]
Turn N+1: [ Stable Prefix ] [ Dynamic Content N+1 ]
                ↑
          Cache hits here — no recomputation
```

## Stabilizer Target

The `stabilizer target` setting controls where dynamic content is attached:

| Target | Behavior | Cache Efficiency |
| :-- | :-- | :-- |
| `developer` | Dynamic content goes in developer messages | Good |
| `user` | Dynamic content goes in user messages | Best |

The `user` target (used in aggressive mode) puts dynamic content further from the model's expected structure, maximizing cache reuse. The `developer` target (used in conservative and normal modes) keeps dynamic content closer to where it logically belongs.

## Visual Feedback

Open the visual inspector to see your stable prefix in action:

```bash
lightmem2 visual
```

The stabilizer view shows:
- Total context size
- Stable portion vs. dynamic portion
- Cache hit/miss ratio
- Per-turn stability metrics

## Tuning

```bash
# Toggle stabilizer
lightmem2 stabilizer on
lightmem2 stabilizer off

# Change target
lightmem2 stabilizer target developer
lightmem2 stabilizer target user
```

## Next

- [Context Reduction](/plugin-catalog/tokenpilot/context-reduction) — trimming tool output
- [Context Eviction](/plugin-catalog/tokenpilot/context-eviction) — pruning old context
- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — see the effect
