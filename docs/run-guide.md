# Run Guide

## 1. Plugin Development Workflow

### Critical: Runtime vs Source

**运行态真源是**：`/mnt/20t/xubuqiang/.openclaw/extensions/ecoclaw/dist/index.js`

Do NOT assume:
- Source code is what's running
- Package build success means runtime is updated

You MUST check the actual runtime extension directory.

### Update Sequence

When developing the plugin locally:

1. **Build** the plugin package
2. **Sync** to runtime extension directory:
   ```bash
   cp /mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/dist/index.js \
      /mnt/20t/xubuqiang/.openclaw/extensions/ecoclaw/dist/index.js
   ```
3. **Verify** runtime directory content (not just build output)

### Verification Commands

```bash
# Byte-level comparison
cmp /mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/dist/index.js \
    /mnt/20t/xubuqiang/.openclaw/extensions/ecoclaw/dist/index.js

# Text marker check (verify specific features are present)
grep -c '\[ecoclaw/task-state\]' /mnt/20t/xubuqiang/.openclaw/extensions/ecoclaw/dist/index.js
```

### Why This Matters

The OpenClaw runtime loads plugins from `~/.openclaw/extensions/`, not from the source repo. If you only rebuild without syncing, the runtime continues running the old version.

## 2. Environment Configuration

### Critical: HOME must be /mnt/20t/xubuqiang

All operations must use `HOME=/mnt/20t/xubuqiang`:
```bash
export HOME=/mnt/20t/xubuqiang
export XDG_CACHE_HOME=/mnt/20t/xubuqiang/.cache
export XDG_CONFIG_HOME=/mnt/20t/xubuqiang/.config
```

### Proxy Variables

Must unset all proxy variables before running:
```bash
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
```

Current machine: For EcoClaw benchmark runs against `kuaipao`, prefer direct run without proxy env.

### API Configuration

- upstream: `https://kuaipao.ai/v1`
- apiKey: `sk-Nf0gcBreOAX9tt0ruwccdpGXyDydIHHXat9e52HByWqLH40g`
- proxyPort: `17668` (if port conflicts, use a free port)
- Model name: **must be `gpt-5.4-mini`** (not `gpt-5-4-mini`)

Judge and model must both use `ecoclaw` chain to avoid 401/403 from old providers.

### Temporary API Choice

As of `2026-04-22`, benchmark default should stay on `kuaipao` for continual runs.

Reason:
- `https://api.tu-zi.com/` works for simple direct curl tests
- but in our OpenClaw streaming path, assistant content may arrive in SSE `response.output_item.done` while `response.completed.response.output` is empty
- current parser path treats that as empty assistant output, causing:
  - `content=[]`
  - `tool_calls=0`
  - every task grading to 0

Conclusion:
- use `kuaipao` as current stable benchmark upstream
- only use `tu-zi` after the SSE completion parsing path is explicitly patched and revalidated

## 3. Pre-run Checklist

Before each run:
- [ ] `HOME=/mnt/20t/xubuqiang`
- [ ] `unset` all proxy variables
- [ ] After install, re-verify openclaw.json ecoclaw config wasn't overwritten
- [ ] Re-check `~/.openclaw/openclaw.json` -> `tools.web.search.provider` and `tools.web.search.apiKey` were not reverted by install/update scripts
- [ ] Gateway log confirms: `embedded responses proxy listening` + `Registered provider ecoclaw/*`
- [ ] Run `task_00_sanity` first as smoke test

## 4. Run Commands

### Smoke test (single task):
```bash
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
export HOME=/mnt/20t/xubuqiang
export ECOCLAW_BASE_URL='https://kuaipao.ai/v1'
export ECOCLAW_API_KEY='sk-Nf0gcBreOAX9tt0ruwccdpGXyDydIHHXat9e52HByWqLH40g'
export ECOCLAW_MODEL='ecoclaw/gpt-5.4-mini'
export ECOCLAW_JUDGE='ecoclaw/gpt-5.4-mini'
export ECOCLAW_SUITE='task_00_sanity'
export ECOCLAW_RUNS='1'
export ECOCLAW_PARALLEL='1'
bash /mnt/20t/xubuqiang/EcoClaw/EcoClaw-Bench/experiments/scripts/run_pinchbench_ecoclaw.sh
```

### Small regression (2 tasks):
```bash
export ECOCLAW_SUITE='task_00_sanity,task_03_blog'
# ... rest same
```

### Full 23 tasks:
```bash
export ECOCLAW_SUITE='all'
export ECOCLAW_PARALLEL='4'
# ... rest same
```

## 5. Output Locations

- benchmark log: `EcoClaw-Bench/log/pinchbench_ecoclaw_<timestamp>_benchmark.log`
- run log: `EcoClaw-Bench/log/pinchbench_ecoclaw_<timestamp>.log`
- result json: `EcoClaw-Bench/results/raw/pinchbench/ecoclaw/*.json`
- cost report: `EcoClaw-Bench/results/reports/ecoclaw_<timestamp>_cost.json`

## 6. Common Issues

### Port conflicts
If proxy port is in use, change `proxyPort` in openclaw.json to a free port, restart, confirm log shows `embedded responses proxy listening at http://127.0.0.1:<port>/v1`.

### Config overwritten
`install_release.sh` overwrites openclaw.json. After install, must restore:
- `plugins.entries.ecoclaw.config.proxyBaseUrl`
- `plugins.entries.ecoclaw.config.proxyApiKey`
- `plugins.entries.ecoclaw.config.proxyPort`
- `plugins.entries.ecoclaw.config.modules.compaction=false`

### Browser issues
Chrome binary path: `/mnt/20t/xubuqiang/chrome/chrome-linux64/chrome`

If browser won't start, check if HOME/XDG directories are writable. Chrome needs to create cache and CDP handshake files.

## 7. Key Lessons (Historical)

1. **Runtime is not source**: Confirmed again 2026-04-22 - must check actual extension directory
2. **Dual HOME causes confusion**: If gateway restarts use different HOME than benchmark, config won't match
3. **Model name format**: Must be `gpt-5.4-mini`, wrong format silently routes to wrong provider
4. **Proxy env vars**: Can cause SSL errors (`curl (35)` / `fetch failed`) when running against kuaipao
5. **Tu-zi SSE mismatch**: Direct API may look healthy, but continual benchmark can still produce empty assistant messages if `response.completed.output` is empty and parser does not rebuild from `response.output_item.done`

## 8. Structured Trace For Context Mutation

When debugging "why did prompt/cache/context change", do not only inspect final result JSON. First check:

```bash
rg 'stable_prefix_rewrite|proxy_before_call_rewrite|proxy_after_call_rewrite|tool_result_persist_applied' \
  /mnt/20t/xubuqiang/.openclaw/ecoclaw-plugin-state/task-state/trace.jsonl
```

### Trace stages

1. `stable_prefix_rewrite`
- source: `rewritePayloadForStablePrefix(...)`
- purpose: detect whether stable-prefix normalization changed the real forwarded input
- key fields:
  - `promptCacheKey`
  - `inputItemCount`
  - `inputChars`
  - `userContentRewrites`
  - `senderMetadataBlocksBefore/After`

2. `proxy_before_call_rewrite`
- source: `applyProxyReductionToInput(...)`
- purpose: measure before-call prompt mutation caused by proxy reduction
- key fields:
  - `inputItemCountBefore/After`
  - `inputCharsBefore/After`
  - `reductionChangedItems`
  - `reductionChangedBlocks`
  - `reductionSavedChars`
  - `reductionSkippedReason`

3. `proxy_after_call_rewrite`
- source: `applyLayeredReductionAfterCall(...)` / SSE after-call path
- purpose: detect whether the upstream response body itself was rewritten before transcript persistence
- key fields:
  - `beforeTextChars`
  - `afterTextChars`
  - `changed`
  - `savedChars`
  - `passCount`
  - `skippedReason`
  - `mode`

4. `tool_result_persist_applied`
- source: `tool_result_persist` hook
- purpose: detect when tool results are archived/replaced by preview text
- key fields:
  - `toolName`
  - `toolCallId`
  - `originalChars`
  - `inlineLimit`
  - `persisted`
  - `outputFile`
  - `dataKey`

### Debug order

When an experiment looks invalid:

1. Check `stable_prefix_rewrite`
2. Check `proxy_before_call_rewrite`
3. Check `proxy_after_call_rewrite`
4. Check `tool_result_persist_applied`
5. Only then inspect final `forwarded-inputs` / `provider-traffic`

This avoids spending hours diffing late-stage artifacts when the real mutation happened earlier in the pipeline.
