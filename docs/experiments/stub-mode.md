# Stub Mode Experiment

## 背景

当前 eviction 的默认模式是 `pointer_stub`：
- 被淘汰的 task 不会完全消失
- 原位置会留下一个句柄 stub
- stub 中包含 archive 路径 / recovery hint / dataKey

这种模式的优点是：
- 可恢复性强
- agent 后续如果需要，可以沿着句柄做 recovery
- 对调试友好，能直观看到哪些 task 被换页

但它也有明显问题：
- stub 本身会污染上下文
- 多个 stub 堆叠后会引入额外 token
- 句柄文案可能干扰模型的后续推理
- 当前形式不够优雅，后续可能需要更轻量的句柄形式

因此这里把 eviction 的替换形式上升为一个独立实验维度。

## 实验目标

比较不同 eviction replacement mode 对以下指标的影响：
- token 开销
- cache 命中
- benchmark 分数
- 后续任务是否被上下文污染
- recovery 能力与可观测性

## 当前支持的模式

### 1. `pointer_stub`

默认模式。

行为：
- archive 原内容
- 在 canonical history 原位置留下一个 assistant stub
- stub 带有 recovery hint

适合：
- 需要保留可恢复入口
- 需要明确观测哪些 task 被换页
- 后续要继续研究 memory fault / recovery 协议

### 2. `drop`

激进模式。

行为：
- archive 原内容
- 直接从 canonical history 中删除整个 task bundle
- 不留下任何 stub

适合：
- 验证最激进换页是否带来更好的 token 收益
- 分析“句柄污染上下文”是否是当前收益不佳的关键原因
- 作为后续更复杂模式的下界对照组

代价：
- 模型看不到任何换页痕迹
- 当前轮次无法沿 stub 做 recovery
- 更适合做纯 token / performance 实验，不适合研究可恢复性

### `drop` 的当前安全约束

`drop` 现在不是“看到 evictable task 就直接删”，而是多了一层协议闭包检查。

原因：
- OpenAI Responses / OpenClaw tool protocol 不是纯文本历史
- 如果只删除 task 的一部分 tool chain，可能会留下悬空的 `function_call_output`
- 这会触发上游 400，例如：
  - `function_call_output requires item_reference ids matching each call_id ...`

当前实现约束：
- 对每个候选 evictable task 集合，检查其中涉及的所有 `call_id`
- 只要某个 `call_id` 的 call/result 没有完整落在候选集合里，就 **defer eviction**
- `memory_fault_recover` 也按普通 tool call 处理，不再单独永久豁免

这意味着：
- recovery 内容仍然不会再进入 reduction / compaction
- 但如果其所在 task 最终满足闭包，它可以随整段 task 一起被 eviction/drop

### 当前实验结论

- `pointer_stub`：协议安全，已能稳定跑 continual
- `drop`：已经补上第一版闭包保护，但还需要继续用 `kuaipao` 回归验证
- `tu-zi` 当前不适合作为 `drop` 的主实验 API，因为流式 Responses 解析还存在兼容问题

## 后续可扩展的模式

未来可以继续加：

### 3. `minimal_stub`
- 只保留极短占位符
- 不带长 recovery 文案
- 例如仅保留 task id / archived 标记

### 4. `aged_stub`
- 刚换页时保留 stub
- 随着距离该 task 的 turns / 交互次数增加，再把 stub 删除
- 用于研究“短期可恢复 + 长期彻底删除”的折中策略

### 5. `summary_stub`
- 不直接放 recovery hint
- 只留一个极短任务摘要
- 兼顾部分语义连续性与较低 token 成本

## 当前实现约定

配置项：
- `eviction.replacementMode`
- 可选值：
  - `pointer_stub`
  - `drop`

bench 脚本环境变量：
- `ECOCLAW_EVICTION_REPLACEMENT_MODE`

默认值：
- `pointer_stub`

## 推荐实验顺序

### 实验 A
- eviction on
- replacementMode = `pointer_stub`

目的：
- 作为当前默认实现

### 实验 B
- eviction on
- replacementMode = `drop`

目的：
- 测试完全删除是否优于当前句柄 stub

### 实验 C
- eviction off

目的：
- 作为干净 baseline

## 我们当前的判断

短期最值得做的是：
1. 先把 `drop` 模式跑通
2. 与 `pointer_stub` 做 10-task continual 对比
3. 观察 token / cache / score 三个指标

如果 `drop` 明显更优，说明当前 stub 形式确实在污染上下文；
如果 `drop` 更差，说明句柄至少在某些任务上仍然有帮助，后续应该继续优化 stub 形式，而不是直接删除。
