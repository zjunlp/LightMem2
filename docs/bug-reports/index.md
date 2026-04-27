# Bug Reports

## 1. task-level eviction only inserted stub, didn't replace original task (2026-04-21)

**Severity**: High

**Phenomenon**:
- `canonical_eviction_applied` triggered with `appliedCount=1`
- But original task messages still remained, only eviction stub was prepended

**Root Cause**:
- `applyCanonicalEviction()` implementation flaw
- Logic was: `stubByIndex.set(bundle.firstIndex, stub)`
- Only non-firstIndex message indexes were added to `skipIndexes`
- So original message at `firstIndex` was not skipped and remained in canonical

**Impact**:
- eviction triggered but didn't reduce canonical context length
- Input token curve didn't show expected drop
- Pollutes judgment of eviction actual benefits

**Fix Direction**:
- Add `firstIndex` to `skipIndexes` then insert stub at that position
- Or do explicit message range replacement instead of prepend semantics

---

## 2. canonical state not stable source (2026-04-22)

**Severity**: High

**Phenomenon**:
- In run 10138: registry advanced, eviction archive generated
- But canonical state didn't reflect real transcript
- Missing early tasks, duplicate user turns, wrong order

**Root Cause**:
- `syncCanonicalState()` assumes `rawMessages` is stable full history
- Uses length comparison to detect new append tail
- But `contextEngine.params.messages` is a context window snapshot, not stable transcript
- This window can truncate/reorder, breaking the prefix-append assumption

**Impact**:
- canonical state gets corrupted over time
- Cannot be used as durable eviction/compaction base

**Resolution**:
- Switched canonical append source to transcript (see architecture/canonical-design.md)
- Now uses message ID based append anchor instead of length

---

## 3. memory_fault recovery protocol visibility (2026-04-18)

**Severity**: Medium

**Phenomenon**:
- `tool_payload_trim` triggered (changed=7, saved_chars=159283)
- But model didn't use `memory_fault(...)` recovery protocol
- Instead re-called `exec` to read same emails repeatedly

**Root Cause**:
- Recovery protocol was in tool result but model didn't treat it as high-priority
- In long batch reading tasks, model preferred to re-read rather than output `memory_fault(...)`

**Resolution**:
- Moved recovery protocol to `payload.instructions` (system-level)
- Trim placeholder shortened to just `memory_fault('<dataKey>')` + `Recovery happens on the next turn`

---

## 4. dataKey lookup file collision (2026-04-19)

**Severity**: Medium

**Root Cause**:
- `key-lookup.json` was overwritten on concurrent writes
- archive files existed but lookup entries were missing

**Resolution**:
- Each `dataKey` now has individual index file: `keys/<sha256(dataKey)>.json`
- Added archive scanning fallback in `resolveArchivePathFromLookup(...)`
- Found entries automatically backfill lookup

---

## 5. continual bench session lock timeout (2026-04-22)

**Severity**: Medium

**Phenomenon**:
- First 4 tasks (01-04) in continual run: `transcript_length=0`, grade=0
- stderr: `session file locked (timeout 10000ms)`

**Root Cause**:
- `task_00_sanity` timed out but held `.jsonl.lock`
- Subsequent tasks immediately hit lock before previous session fully exited

**Resolution**:
- Added `_wait_for_continuous_session_unlock(agent_id)` guard
- Default wait: 420s, poll every 2s

---

## 6. progress grader log storm (2026-04-22)

**Severity**: Low

**Phenomenon**:
- Millions of "Found transcript via sessionFile... (attempt 1)" log lines

**Root Cause**:
- `_run_progress_grader_loop()` reloaded transcript every round
- `_load_transcript()` logged success from attempt 1 each time

**Resolution**:
- Transcript reloads only when `completed_jobs` count changes
- Added `log_success=False` parameter

---

## 7. memory_fault detection false positive from SSE instructions echo (2026-04-18)

**Severity**: Medium

**Phenomenon**:
- Previous stats showed 126 `memory_fault(...)` occurrences in proxy_forwarded/proxy_outbound
- But `memory_fault_recovery` actual count was much lower

**Root Cause**:
- `memory_fault` detection was scanning entire upstream response text
- For SSE responses, `response.created` event echoes back the full `instructions`
- Since recovery protocol was injected into `payload.instructions`, the literal `<dataKey>` was falsely detected

**Resolution**:
- Changed detection to only scan "real assistant output text"
- SSE: use `collectSseOutputText(...)`
- JSON: parse and use `extractProxyResponseText(...)`
- Filter out literal placeholder values like `<dataKey>`

---

## 8. memory_fault recovery blocked by stopReason=stop (2026-04-18)

**Severity**: Medium

**Phenomenon**:
- Assistant output `memory_fault('segment:proxy-5-output')` with `stopReason = "stop"`
- Recovery request was persisted but benchmark run ended immediately
- `before_call` recovery never executed, task ended with 0 score

**Root Cause**:
- Recovery design assumed "next external message triggers next round"
- But PinchBench single-task runs are self-contained agent loops
- No follow-up user message after assistant's recovery output

**Resolution**:
- Added conservative auto-replay logic in proxy layer:
  - If assistant output contains `memory_fault(...)` AND no tool calls in same response
  - Proxy persists recovery request and re-runs the same payload internally
  - Allows `memory_fault_recovery` to execute in `before_call`
- Replay limited to 1 iteration to avoid loops

---

## 9. memory_fault internal tool migration (2026-04-18)

**Severity**: Medium

**Status**: Resolved

**Migration**:
- Changed from text protocol `memory_fault(...)` to internal tool
- Tool name: `memory_fault_recover` with parameter `{"dataKey": "..."}`
- Old proxy auto-replay logic disabled, waiting for internal tool path to stabilize

**Verification**:
- Full run 10049: score 0.8529, 133 API requests
- `memory_fault_recover` executed 7 times, all successful, 0 `archive_not_found`

---

## 10. canonical prune wrote toolResult.content as string "pruned" (2026-04-20)

**Severity**: High

**Phenomenon**:
- Second half of continual runs had systematic crash
- Only `user` + `assistant(error)` messages remained
- judge gave "only the user request, no evidence of work"

**Root Cause**:
- `pruneCanonicalMessages(...)` wrote `toolResult.content` as string `"[pruned]"`
- OpenClaw later called `msg.content.filter(...)` on this string
- Error: `msg.content.filter is not a function`

**Resolution**:
- Changed to write block array: `content: [{ type: "text", text: placeholder }]`

---

## 11. eviction generated duplicate stubs / repeated archive (2026-04-20)

**Severity**: Medium

**Phenomenon**:
- Same task got archived multiple times in one session
- Canonical state filled with duplicate stubs
- `canonical_eviction_applied` triggered repeatedly on same task

**Root Cause**:
- Task-level stub didn't have stable identity
- Subsequent annotation logic rebind stub to different `turnAbsId/taskIds`
- Eviction became non-idempotent

**Resolution** (in progress):
- Make task-level stub have stable,不会被后续 annotation 覆盖的 task identity
- Ensure idempotent eviction:
  - Already-evicted task should not be archived again
  - Already-evicted task should not get stub inserted again

---

## 12. hidden context mutation paths made experiments hard to trust (2026-04-23)

**Severity**: High

**Phenomenon**:
- Experiment token curves or cache behavior looked wrong
- Final payload diffing was expensive and often inconclusive
- The real mutation could have happened in multiple earlier stages

**Root Cause**:
- Several hooks can mutate prompt/response/persisted tool output before the final forwarded payload is inspected:
  - stable prefix rewrite
  - proxy before-call reduction
  - proxy after-call reduction
  - tool_result_persist

**Resolution**:
- Added structured trace stages:
  - `stable_prefix_rewrite`
  - `proxy_before_call_rewrite`
  - `proxy_after_call_rewrite`
  - `tool_result_persist_applied`
- These traces are written to:
  - `/mnt/20t/xubuqiang/.openclaw/ecoclaw-plugin-state/task-state/trace.jsonl`

**Operational Rule**:
- When an experiment looks invalid, first inspect these structured traces before reading `forwarded-inputs` or `provider-traffic`.

---

## 12. task fragmentation放大 eviction重复执行 (2026-04-20)

**Severity**: Medium

**Phenomenon**:
- Single benchmark task split into multiple `tN-task` by estimator
- e.g., `t2-task / t3-task / t4-task / t5-task ...` within one benchmark task

**Impact**:
- Eviction triggered on fragmentary tasks instead of complete ones
- Archive count exploded
- Stub count in canonical state excessive
- Prompt load curve became unexplainable

**Root Cause**:
- Sliding window estimator input mode lacks task continuity context
- Tends to split long-running tasks into many subtasks

---

## 13. canonical task re-annotation rebound surviving messages back to `t1` (2026-04-22)

**Severity**: High

**Phenomenon**:
- Global LLM-call token curves showed many visible dips during `drop` runs
- At first glance this looked like many tasks were being evicted successfully
- But trace showed `canonical_eviction_applied.appliedTaskIds` repeatedly contained only:
  - `...:t1-task`
- In some rewrites, `canonical_state_rewrite.afterEvictionMessageCount` dropped all the way to `0`

**Root Cause**:
- `annotateCanonicalMessagesWithTaskAnchors()` re-assigned task anchors from the beginning of the canonical message list on every rewrite
- Once earlier `user` messages were removed by eviction, later surviving messages lost the original turn boundary context
- Those surviving messages were then rebound to the earliest remaining anchor, often `t1-task`
- This made eviction repeatedly delete the same logical task instead of progressing to later tasks

**Impact**:
- Repeated prompt-length dips in charts overstated real eviction progress
- Same early task could be re-evicted many times
- Canonical state could collapse to empty even though later tasks still existed in the registry
- Closure analysis became misleading because the task binding itself was already wrong

**Resolution**:
- Re-annotation now preserves existing valid `turnAbsId/taskIds` anchors
- Only messages missing anchors are assigned anchors by sequential scan
- Runtime plugin rebuilt and re-synced

**Validation target**:
- `canonical_eviction_applied.appliedTaskIds` should stop repeating only `t1-task`
- `canonical_state_rewrite.afterEvictionMessageCount` should no longer repeatedly collapse to `0`

---

## 13. drop eviction broke tool protocol closure (2026-04-22)

**Severity**: High

**Phenomenon**:
- `drop` mode continual run scored far below baseline
- later tasks failed with:
  - `400 function_call_output requires item_reference ids matching each call_id ...`
- final canonical state could collapse to a tiny fragment such as a lone recovery `toolResult`

**Root Cause**:
- task-level `drop` removed messages by task boundary only
- it did not ensure that tool protocol chains were removed as a **closed set**
- worse, `memory_fault_recover` results had `eviction.skip=true`, so the recovery result could survive while the surrounding call/context was evicted

**Resolution**:
- removed permanent `eviction.skip` for `memory_fault_recover`
- added first-pass `call_id` closure check before canonical eviction:
  - if a candidate evictable task only contains part of a protocol chain, eviction is deferred
  - `memory_fault_recover` is treated as a normal tool call/result pair

---

## 14. tu-zi streaming Responses produced empty assistant transcript (2026-04-22)

**Severity**: High

**Phenomenon**:
- continual benchmark run on `https://api.tu-zi.com/` produced near-all-zero scores
- each task showed:
  - `llm_calls = 1`
  - `tool_calls = 0`
  - assistant transcript message had `content = []`, `stopReason = "stop"`
- direct curl tests to `tu-zi` still returned valid text

**Root Cause**:
- likely SSE compatibility mismatch
- in direct streaming tests, assistant text appeared in:
  - `response.output_item.done`
  - `response.output_text.delta/done`
- but `response.completed.response.output` could be empty
- current OpenClaw/plugin parsing path relies too heavily on the completed response body

**Operational Decision**:
- revert benchmark upstream back to `kuaipao`
- treat `tu-zi` as a future parser compatibility task, not the main benchmark provider for now

**Resolution**:
- See estimator_mode.md: compare `sliding_window` vs `completed_summary_plus_active_turns` modes

## Web Search Provider

- OpenClaw 原生 `web_search` 默认就是 `Brave`，不是插件自己额外代理的搜索实现。
- 本地参考：`~/.openclaw/workspace/openclaw-prompts-reference.md` 明确写了 `web_search: Search the web (Brave API)`。
- 运行时配置也显示 `web_search` 的 `provider` 是 `brave`：`~/.openclaw/openclaw.json`。
- 因此 `task_06_events` / `task_18_market_research` 这类 research 任务里出现的搜索失败，不应先怀疑“没有 web_search 工具”，而应先检查：
  - Brave API key 是否有效
  - Brave 配额/限流是否触发
  - 网络层是否出现 `fetch failed`
- 现有日志里已经能看到两类失败：
  - `Brave Search API error (429)`
  - `fetch failed`
- 工程建议：
  - 把 `web_search` 失败优先归类为 provider/key/quota 问题，不要误判成工具缺失。
  - 如果要提升稳定性，再考虑增加 Serper 之类的备用搜索 provider，但这属于 provider fallback，不是“补一个全新 web_search 工具”。

### Brave Key Verification

- 2026-04-23 直接用新 Brave key 做了原生 API 探测，返回 `HTTP 200`，并能正常返回 JSON 搜索结果。
- 当前已验证可用的新 key：`BSAVY31Vr2bEqJeb0SQXOXSDiIwRZ77`。
- 因此之前 research 任务里的 `web_search` 失败，主要应归因于旧 key 的配额/限流，而不是 OpenClaw 没有 `web_search` 工具。
- 当前运行时配置 `~/.openclaw/openclaw.json` 已更新为新 Brave key。

## PinchBench Task 22 Multi-Session Slicing Bug

- 问题现象：`task_22_second_brain` 在 `continuous + deferred final grading` 下，生成本身是成功的，但最终结果里 `transcript_length = 0`、`transcript_span = 0..0`，judge 因为拿到空 transcript 而给出低分。
- 直接表现：结果 JSON 中 `stdout` 明明包含正确的存储与回忆答案，但 `transcript` 为空，judge notes 为 `No agent transcript or evidence of any actions was provided`。
- 根因：bench 的 continual final slicing 逻辑只按单个 `task.prompt` 去主 transcript 里匹配边界；而 `task_22_second_brain` 是 `multi_session: true`，真实前端 prompt 来自 `frontmatter.sessions[]` 中的 3 个 session prompt，因此旧逻辑找不到起始边界。
- 修复：
  - 新增按 `frontmatter.sessions[]` 提取 prompt 序列的 helper。
  - continual final grading 和 progress grading 都改为按多 session prompt 顺序匹配边界。
- 验证：单独回归 `task_22_second_brain`（run `10164`）后，final grade 恢复为 `0.9/1.0 (95%)`，judge 正常识别到写入 `memory/MEMORY.md`、同 session recall 和跨 session recall。
- 结论：这个问题是 bench transcript slicing bug，不是 memory tool / retrieval 能力缺失。

## Exec allowlist can silently break file-discovery tasks

Observed in full run `10165` (`pinchbench_ecoclaw_20260423_200947_generate.log`).

Symptoms:
- `task_15_daily_summary` and `task_17_email_search` failed before real work started.
- Agent tried shell-based directory discovery (`find ... | sort`) and got `exec denied: allowlist miss`.
- Fallback `read` on the directory then failed with `EISDIR`.
- The agent stopped and asked for filenames, so no deliverable file was produced.

Impact:
- This is not an eviction/decoupling failure. It is a host exec approvals / allowlist failure.
- Baseline `10154` did not hit this path, so score regressions here can be misleading if treated as context-management regressions.

Mitigation applied:
- Added common directory-discovery binaries to host-local exec approvals allowlist (`~/.openclaw/exec-approvals.json`):
  - `/usr/bin/find`
  - `/usr/bin/ls`
  - `/usr/bin/sort`
  - `/usr/bin/grep`
  - `/usr/bin/head`
  - `/usr/bin/tail`
  - `/usr/bin/wc`
  - `/usr/bin/cut`
  - `/usr/bin/tr`
  - `/usr/bin/uniq`
- Backups created alongside the approvals files with suffix `.bak_allowlist`.

Caveat:
- `task_19_spreadsheet_summary` appears to need interpreter-style exec for Excel parsing. Directory-discovery allowlist fixes do not solve that by themselves. Do not casually allowlist `python`/`bash`; prefer a dedicated reader/tool if possible.

## PinchBench `continuous` was only same-agent serial, not true single-session continual

- Symptom:
  - In newer runs, the baseline first call of each task stayed near a flat floor (`input + cache_read ~= 9.5k`) instead of continuing to climb across tasks.
  - This made the baseline look as if context was being reset at each task boundary, while eviction-enabled runs still appeared to accumulate history.

- Root cause:
  - `benchmark.py` correctly reuses one agent and one workspace in `--session-mode continuous`.
  - However, `lib_agent.py` previously regenerated a fresh `current_session_id` at the start of every task, and again for any `new_session` step inside a task.
  - This meant PinchBench "continuous" was actually:
    - same agent
    - same workspace
    - serial task order
    - but **new session per task**
  - That is a same-agent serial setting, not a true single-session continual benchmark.

- Why this was confusing:
  - OpenClaw transcript persistence does not use the passed `--session-id` as a stable on-disk filename; `lib_agent.py` already had to resolve the real transcript via `sessions.json` / recent `.jsonl`.
  - Because the plugin also maintains its own canonical history / session topology, some method runs still looked "continual", which masked the benchmark bug.

- Fix:
  - `continuous` mode now keeps one active session timeline across tasks.
  - Each new task reuses the currently active session id.
  - If a task explicitly requests `new_session` in its `frontmatter.sessions[]`, that task step creates a new session and the resulting new session becomes the active session for subsequent tasks.
  - This preserves task-level multi-session evaluation (for example `task_22_second_brain`) while making cross-task continual execution semantically correct.

- Operational implication:
  - Old "continuous" runs from before this fix should be treated as same-agent serial, not as strict single-session continual results.

---

## 13. PinchBench continuous was same-agent serial, not true cross-task continual (2026-04-25)

**Severity**: High

**Phenomenon**:
- Old `continuous` runs reused the same `agent_id` and workspace, but task-to-task context did not always accumulate as a single continual timeline.
- Baseline-like runs could look as if each task started from a near-reset prompt, while eviction-enabled runs appeared more continual.

**Root Cause**:
- `benchmark.py` only enforced same-agent serial execution.
- `lib_agent.py` still generated a fresh `session_id` at the start of each task.
- This made `continuous` depend on OpenClaw/plugin side effects rather than an explicit benchmark-owned active session timeline.

**Resolution**:
- Bench now maintains one active `continuous_session_id` across tasks.
- `execute_openclaw_task(...)` accepts an initial session and returns the final session used by the task.
- Explicit task-level `new_session` is still honored, and the new session becomes the active session for following tasks.

**Verification**:
- In continual smoke run `10189`, the first-call `input + cache_read` rose across tasks:
  - `task_20`: `9517`
  - `task_21`: `34314`
  - `task_22`: `39806`
- This confirmed true cross-task accumulation at the benchmark layer.

---

## 14. plugin history sync must follow real OpenClaw sessionId (2026-04-25)

**Severity**: High

**Phenomenon**:
- After fixing bench continual semantics, plugin-side history could still be carried across a native `new session` boundary.
- The benchmark session boundary and plugin-maintained history boundary were not guaranteed to match.

**Root Cause**:
- Runtime hooks had fallback paths that used `sessionKey` when `upstreamSessionId` was absent.
- That allowed transcript sync / canonical updates to continue on a logical binding even after a real OpenClaw session boundary should have cut history.

**Resolution**:
- Plugin runtime history sync now keys on the real OpenClaw `sessionId` only.
- Removed `sessionKey` fallback from the runtime transcript-sync path and payload session resolution.

**Verification**:
- In continual no-eviction + estimator smoke run `10192`, task-level continual accumulation remained intact, while `task_22` still graded correctly with explicit `new_session` semantics.

---

## 15. judge tool restriction must not mutate global plugin modules (2026-04-25)

**Severity**: High

**Phenomenon**:
- Hybrid grading runs became very slow and unstable.
- Judge setup triggered gateway reloads during evaluation.
- After the run, the main runtime config was often left in a disabled-module state.

**Root Cause**:
- `_restrict_judge_tools()` in `lib_grading.py` did not only patch the judge agent entry.
- It also rewrote global `plugins.entries.ecoclaw.config.modules`, which forced gateway reload/restart and polluted the main experiment config.

**Resolution**:
- Judge restriction now only patches the judge agent's denied tools.
- It no longer edits global plugin module config.

**Verification**:
- In run `10192`, judge setup no longer triggered gateway reload, and the main plugin config remained stable across grading.

---

## 16. project rename must separate brand strings from runtime ids (2026-04-26)

**Severity**: Medium

**Phenomenon**:
- During the `legacy brand -> TokenPilot` transition, user-facing docs and metadata
  were safe to rename quickly, but runtime ids, provider prefixes, state paths,
  and config slots were still tightly coupled to benchmark/runtime behavior.
- A naive global rename would have mixed harmless branding edits with
  high-risk runtime mutations.

**Root Cause**:
- The project exposes two naming layers:
  - brand-facing names in README/docs/package metadata
  - runtime/internal ids such as `ecoclaw`, `ecoclaw-context`, `ecoclaw/*`,
    `ECOCLAW_*`, and `~/.openclaw/ecoclaw-plugin-state`
- Those two layers have very different risk profiles, but were easy to confuse
  during migration work.

**Resolution**:
- Adopt an explicit rename boundary:
  - brand-layer renames first
  - runtime/internal rename only under a dedicated compatibility migration
- Add migration guidance and keep benchmark/runtime validation in the loop.

**Operational Rule**:
- If the method name changes again later, repeat the brand-layer migration
  process first.
- Do not start with a repo-wide runtime/global string replacement.
