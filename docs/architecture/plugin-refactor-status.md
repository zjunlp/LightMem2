# Plugin Refactor Status

## Why `openclaw-plugin/src/index.ts` became too large

`packages/openclaw-plugin/src/index.ts` historically同时承担了两类职责：

- plugin bootstrap / hook wiring
- canonical history、proxy reduction、task-state persistence、trace 等实逻辑

这会把 integration 和 domain logic 混在一起。后果就是：

- 很难确认哪条链路还在生效
- 容易留下 stale path
- 实验结果被隐藏副作用污染后不容易发现

## Current direction

当前目标是把 `index.ts` 收敛成 orchestration / composition root，而不是继续作为所有行为的实现文件。

## Current live layers

当前主运行路径明确还在用的是：

- `packages/layers/decision/`
- `packages/layers/history/`
- `packages/openclaw-plugin/`

当前实验主链里，没有把下面两层作为主入口来用：

- `packages/layers/context/`
- `packages/layers/orchestration/`

## Current eviction path

当前真正生效的 eviction 主链分成两段：

1. Decision side
- `packages/layers/decision/src/policy.ts`
- 负责决定哪些 task 进入 `evictable`
- 在 decoupled 模式下，FIFO promotion 负责产出 `evictableTaskIds`

2. Canonical execution side
- `packages/openclaw-plugin/src/canonical/eviction.ts`
- 负责对 durable canonical history 做 task-level canonical eviction

## Canonical split already completed

目前已经从 `index.ts` 抽出去的 canonical 逻辑有：

### `canonical/state.ts`
- canonical state load/save
- transcript append
- message-char estimation

### `canonical/anchors.ts`
- task anchor sorting
- canonical message task-anchor annotation

### `canonical/eviction.ts`
- closure deferral check
- canonical task archive lookup
- task-level canonical eviction apply

### `canonical/rewrite.ts`
- transcript sync into canonical state
- canonical annotation + eviction rewrite orchestration
- canonical rewrite trace emission

### `trace/io.ts`
- task-state trace append
- forwarded-input dump append
- reduction pass trace append
- shared JSONL append helper

### `trace/hooks.ts`
- llm hook tap path resolution
- llm hook monitoring/tap registration
- hook event trace shaping

### `proxy/stable-prefix.ts`
- stable prefix normalization
- payload-level cache-key rewrite
- sender metadata stripping
- request input char estimation
- turn-binding normalization helpers

### `proxy/after-call-reduction.ts`
- JSON response text extraction/patching
- SSE response text extraction/patching
- after-call layered reduction execution
- after-call reduction result shaping

### `proxy/before-call-reduction.ts`
- before-call reduction entrypoint
- before-call reduction result shaping
- reduction pipeline application
- pre-reduction policy hook integration

### `proxy/reduction-context.ts`
- before-call reduction context builder
- proxy input tool-payload segmentation
- repeated-read dedup instruction shaping
- exec-output threshold evaluation
- recovery-aware reduction gating

### `proxy/reduction-helpers.ts`
- ordered turn anchor loading
- tool-call to task-anchor loading
- reduction pass enable/disable gate

### `tool-results/persist.ts`
- tool_result_persist policy execution
- artifact archival + preview fallback shaping
- contextSafe metadata update for persisted tool results
- persistence trace emission

### `transcript/sync.ts`
- transcript row loading and stable-id derivation
- event.messages -> raw semantic turn extraction
- transcript -> raw semantic turn sync
- turn observation extraction with recovery-aware metadata

### `session/topology.ts`
- upstream session binding
- runtime session-key -> OpenClaw session-id binding

### `session/turn-bindings.ts`
- recent turn binding state load/save
- provider-side turn-binding persistence

### `runtime/helpers.ts`
- shared logger/hook helpers
- session/user-message extraction helpers
- tool-result/contextSafe helpers
- canonical helper functions shared by runtime wiring
- provider-response extraction helpers
- OpenClaw session-id extraction helpers

### `config.ts`
- plugin config types
- config normalization
- shared config helpers (`safeId`, `asRecord`, `extractPathLike`)
- policy-module config builder
- before-call policy bridge

### `context-engine.ts`
- context-engine bootstrap
- canonical context assemble/compact orchestration
- task-cache workspace purge wrapper

### `recovery/common.ts`
- recovery marker constants
- contextSafe recovery metadata lookup
- recovery contextSafe patch shaping

### `recovery/protocol.ts`
- memory-fault recovery instruction injection
- internal payload marker stripping

### `recovery/tool.ts`
- `memory_fault_recover` tool registration
- archive lookup and recovered payload shaping

### `proxy/upstream.ts`
- upstream provider discovery
- proxy model config sync
- fetch/curl transport fallback
- upstream transport trace emission

### `proxy/provider.ts`
- provider registration glue for embedded proxy
- mirrored model definition shaping

### `proxy/runtime.ts`
- embedded local `/v1/responses` runtime
- request forwarding orchestration
- proxy-side stable-prefix/reduction/trace glue

### `execution/reduction/*`
- plugin-local reduction pipeline
- reduction registry and types
- moved from `packages/layers/execution/src/composer/reduction/*`

### `execution/passes/*`
- plugin-local atomic reduction passes
- moved from `packages/layers/execution/src/atomic/passes/*`

### `execution/archive-recovery/*`
- plugin-local archive/recovery storage helpers
- moved from `packages/layers/execution/src/atomic/archive-recovery/*`

## Remaining split plan

如果继续拆，剩下真正值得动的只剩一类：

### `trace/`
- trace payload builders and per-feature monitor shaping
- optional monitor logger extraction from runtime register

### `execution migration`
- plugin-local `src/execution/` is now the only live execution surface
- `reduction`, atomic `passes`, and `archive-recovery` are plugin-local
- plugin runtime no longer depends on `packages/layers/execution`
- legacy layer-side execution package has been removed

## Why this matters

这次拆分不是样式整理，而是为了降低下面这些风险：

- 老 eviction path 还活着但不容易发现
- plugin-local transforms 在暗中修改 prompt 结构
- integration leftovers 继续污染实验结论

## Latest status
- `register(api)` runtime orchestration has been moved to `packages/openclaw-plugin/src/runtime/register.ts`.
- `index.ts` now mainly owns proxy-runtime helper wiring, test hooks, and final plugin export glue.
- plugin-side legacy `compaction` runtime/config compatibility has been removed.
- summary controls now live under `plugins.entries.ecoclaw.config.summary.*`.
- legacy `/ecoclaw` command wiring and task-cache workspace deletion helpers have been removed from the live runtime.
