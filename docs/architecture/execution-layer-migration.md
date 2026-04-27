# Execution Layer Migration to Plugin

## Goal

把原来的 `packages/layers/execution/` 活跃模块迁移到 `packages/openclaw-plugin/src/` 下，让 plugin 成为真正的 composition root。该迁移现已完成，旧 package 已删除。

---

## Current plugin structure

```
openclaw-plugin/src/
  canonical/           ← 已有：eviction, state, anchors, rewrite
  proxy/              ← 已有：before-call/after-call reduction, stable-prefix
  recovery/           ← 已有：memory fault recovery 协议
  root-prompt-stabilizer.ts  ← 已有
  index.ts            ← composition root（~242行）
```

---

## Legacy execution structure

原 `packages/layers/execution/` 已整体删除；下面的结构仅作为迁移记录保留。
其中出现的旧 package/import 名称反映的是当时的删除现场，不代表当前
`@tokenpilot/*` 工作区命名。

---

## What is being migrated

### Phase 1 — Migrated now

Status: completed on 2026-04-24.


| 模块 | 来源 | 目标位置 | 说明 |
|------|------|---------|------|
| `reduction/pipeline` | `composer/reduction/` | `execution/reduction/` | `runReductionBeforeCall`, `runReductionAfterCall`, `resolveReductionPasses` |
| `reduction/registry` | `composer/reduction/` | `execution/reduction/` | pass 注册表 |
| `reduction/types` | `composer/reduction/` | `execution/reduction/` | 类型定义 |
| `passes/*` | `atomic/passes/` | `execution/passes/` | 12个原子 pass |
| `archive-recovery/*` | `atomic/archive-recovery/` | `execution/archive-recovery/` | archive + read + recovery 存储层 |

### Phase 2 —暂不动（后续按需）

| 模块 | 状态 | 原因 |
|------|------|------|
| `compaction/*` | 已删除 | plugin runtime 已断开，layer-side compaction implementation removed |

---

## Target structure after migration

```
openclaw-plugin/src/
  canonical/           ← 不动
  proxy/              ← 不动
  recovery/           ← 不动（已在 plugin）
  execution/          ← 新增
    reduction/
      pipeline.ts
      registry.ts
      types.ts
    passes/
      pass-repeated-read-dedup.ts
      pass-tool-payload-trim.ts
      pass-html-slimming.ts
      pass-exec-output-truncation.ts
      pass-agents-startup-optimization.ts
      pass-format-slimming.ts
      pass-format-cleaning.ts
      pass-path-truncation.ts
      pass-image-downsample.ts
      pass-line-number-strip.ts
      index.ts
    archive-recovery/
      index.ts
  root-prompt-stabilizer.ts  ← 不动
  index.ts            ← 更新 import 路径
```

---

## Module relationships

```
layers/execution/atomic/archive-recovery/
  archiveContent()         ← 被 eviction.ts 和 plugin/recovery/tool.ts 共同调用
  readArchive()            ← 被 plugin/recovery/tool.ts 调用
  buildRecoveryHint()      ← 被 eviction.ts 调用
  resolveArchivePathFromLookup() ← 被 plugin/recovery/tool.ts 调用
```

---

## Import updates required

以下文件需要更新 import 路径，从 `layers/execution/` 改为 plugin 内的新路径：

| 文件 | 当前 import | 目标 import |
|------|------------|------------|
| `index.ts` | `reduction/pipeline.js` | `execution/reduction/pipeline.js` |
| `index.ts` | `archive-recovery/index.js` | `execution/archive-recovery/index.js` |
| `index.ts` | `compaction/index.js` | 已移除 |
| `canonical/eviction.ts` | `archive-recovery/index.js` | `execution/archive-recovery/index.js` |
| `proxy/before-call-reduction.ts` | `reduction/pipeline.js` | `execution/reduction/pipeline.js` |
| `proxy/after-call-reduction.ts` | `reduction/pipeline.js` | `execution/reduction/pipeline.js` |
| `tool-results/persist.ts` | `archive-recovery/index.js` | `execution/archive-recovery/index.js` |
| `recovery/tool.ts` | `archive-recovery/index.js` | `execution/archive-recovery/index.js` |
| `reduction-proxy.test.ts` | `compaction/index.js` | 已移除 |

---

## Also delete

- `packages/layers/execution/src/composer/stabilizer/*` — 已删除，plugin 用自己的 `root-prompt-stabilizer.ts`
- `packages/layers/execution/src/composer/eviction/*` — 空目录，export 已移除
- `packages/layers/execution/src/composer/reduction/*` — 已删除，plugin 已迁入 `src/execution/reduction/*`
- `packages/layers/execution/src/atomic/passes/*` — 已删除，plugin 已迁入 `src/execution/passes/*`

---

## Execution package removal

已完成：
- 删除整个 `packages/layers/execution/` 目录
- 清理 `tsconfig.base.json` 中的 `@ecoclaw/layer-execution` path mapping


---

## Rollback plan

```bash
# 迁移前备份
cp -r packages/layers/execution packages/layers/execution.bak

# 回滚：恢复 import 路径即可
```

## Current status

After the cleanup on 2026-04-24:

- `reduction`, `passes`, and `archive-recovery` are plugin-local
- plugin runtime no longer imports `packages/layers/execution/`
- legacy `packages/layers/execution/` package has been removed
- legacy decision-side compaction analysis has also been removed
- plugin config no longer exposes `compaction.*`; summary knobs now live under `summary.*`
