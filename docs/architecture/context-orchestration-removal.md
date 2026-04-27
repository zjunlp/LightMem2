# Remove `layer-context` and `layer-orchestration`

## Why these two layers

`openclaw-plugin/index.ts` 是当前唯一的运行入口，主链路是：

```
OpenClaw hooks → openclaw-plugin/index.ts
                     ↓
              layers/decision/ (policy.ts - 决策)
              layers/history/ (transcript/registry)
              openclaw-plugin/src/execution/ (plugin-local reduction/archive-recovery)
```

`layer-context` 和 `layer-orchestration` 从未被主链路经过：

- **`layer-orchestration`**：`createOpenClawConnector` 封装了 `RuntimePipeline`/`RuntimeModule` 体系，插件没使用
- **`layer-context`**：设计从 `RuntimeStateStore` 构建 session view，但插件直接读写 JSON canonical state，`RuntimeStateStore` 从未被使用

开源前清理死代码，降低维护负担。

---

## What `locality.ts` does (and why it matters)

`layer-decision/src/policy.ts` 大量使用 `locality.ts` 导出的 `analyzePolicyLocality()`：

```typescript
// policy.ts:1003
const locality = analyzePolicyLocality({ ctx, cfg: config.locality });
```

`analyzePolicyLocality` 的逻辑是：
1. 从 `ctx.metadata.contextView` 读取 `ContextViewSnapshot`
2. 在 message 级别构建 signals（hard_loop、error、structural_payload、subtask_boundary 等）
3. 产出 `reductionCandidateChars`、`summaryCandidateChars` 等供决策使用

**但实际运行时**：插件从未填充 `ctx.metadata.contextView`，所以 `analyzePolicyLocality` 每次都走 fallback 分支：

```typescript
// locality.ts:813
const contextView = readContextViewSnapshot(ctx.metadata);
if (!contextView) {
  return {
    source: "none",
    signalCount: 0,
    reductionCandidateChars: 0,
    // ... all empty
  };
}
```

**结论**：`locality.ts` 的逻辑完整存在，但始终返回 empty。保留它，未来如果有人想启用 locality-based 决策，只需要填充 `contextView` 字段即可。

---

## Dependency graph (before removal)

The dependency graph below preserves the package names that existed at removal
time. Those package names have since been migrated to the `@tokenpilot/*`
namespace.

```
layer-orchestration/
  @ecoclaw/kernel
  @ecoclaw/layer-context      ← 唯一外部引用
  @ecoclaw/storage-fs

layer-context/
  @ecoclaw/kernel             ← 仅被以下引用

layer-decision/
  @ecoclaw/kernel
  @ecoclaw/layer-history
  @ecoclaw/layer-context      ← 仅 type import（locality.ts, test-utils.ts）
                                   ↕
                              实际运行时 locality.ts 永远读不到 contextView
                              → 始终返回 empty，不影响决策结果
```

---

## Removal order (completed)

The import examples below are historical diffs from the pre-rename package
namespace. They are kept as migration records, not as the current active
package names.

### ✅ Phase 1 — Remove `layer-orchestration`

无外部引用，直接删除整个目录：

```
packages/layers/orchestration/
```

### ✅ Phase 2 — Inline types into `locality.ts`

`locality.ts` 从 `layer-context` 引入的只有两个 type：
- `ContextViewSnapshot`
- `ContextViewMessageSnapshot`

**改动点**：`packages/layers/decision/src/locality.ts`

```diff
- import type { ContextViewMessageSnapshot, ContextViewSnapshot } from "@ecoclaw/layer-context";
- import type { RuntimeTurnContext } from "@ecoclaw/kernel";
+ import type { RuntimeTurnContext } from "@ecoclaw/kernel";
+ import type { PersistedMessageKind, PersistedMessageOrigin, PersistedMessageRole } from "@ecoclaw/kernel";
+ // Inlined from @ecoclaw/layer-context (being removed)
+ export type ContextViewMessageSnapshot = { ... };
+ type ContextViewBranchSnapshot = { ... };
+ type ContextViewStats = { ... };
+ export type ContextViewSnapshot = { ... };
```

类型定义来自 `layer-context/src/view.ts` 的 49–92 行。

### ✅ Phase 3 — Inline types into `test-utils.ts`

**改动点**：`packages/layers/decision/tests/test-utils.ts`

同样的内联处理，删除 `@ecoclaw/layer-context` import，内联 `ContextViewSnapshot` 和 `ContextViewMessageSnapshot` 类型。

### ✅ Phase 4 — Remove `layer-context`

```
packages/layers/context/
```

### ✅ Phase 5 — Clean `package.json` and `tsconfig` references

**`packages/layers/decision/package.json`**：

```diff
  "dependencies": {
-   "@ecoclaw/layer-context": "workspace:*",
    "@ecoclaw/layer-history": "workspace:*",
    "@ecoclaw/kernel": "workspace:*"
  }
```

**`tsconfig.base.json`** — 删除 path mappings：

```diff
-    "@ecoclaw/layer-context": [
-        "packages/layers/context/src/index.ts"
-    ],
...
-    "@ecoclaw/layer-orchestration": [
-        "packages/layers/orchestration/src/index.ts"
-    ],
```

### ✅ Phase 6 — Verify

```bash
pnpm install
# layer-decision typecheck: PASS
# kernel typecheck: PASS
# openclaw-plugin typecheck: PASS
```

---

## Post-removal status

- [x] `packages/layers/orchestration/` — 已删除
- [x] `packages/layers/context/` — 已删除
- [x] `tsconfig.base.json` path mappings — 已清理
- [x] `layer-decision/package.json` — 已移除 `@ecoclaw/layer-context` 引用
- [x] `locality.ts` — 类型已内联，不再依赖 `layer-context`
- [x] `test-utils.ts` — 类型已内联，不再依赖 `layer-context`
- [x] typecheck 全部通过

**额外清理（execution 层，死代码）**：
- `packages/layers/execution/src/atomic/summary/*` — 已删除
- `packages/layers/execution/src/atomic/handoff/*` — 已删除
- `packages/layers/execution/tests/summary.test.ts` — 已删除
- `packages/layers/execution/tests/handoff.test.ts` — 已删除
- `packages/layers/execution/src/composer/eviction/` 空目录 export — 已从 `composer/index.ts` 移除

---

## Rollback plan

```bash
# 已删除的目录备份位置（如需回滚）
packages/layers/orchestration/  # 已删除
packages/layers/context/       # 已删除

# 回滚步骤：
# 1. 从 git 历史恢复目录
# 2. 恢复 tsconfig.base.json 中的 path mapping
# 3. 恢复 layer-decision/package.json 中的 dependency
# 4. 恢复 locality.ts 和 test-utils.ts 中的 import 语句
```
