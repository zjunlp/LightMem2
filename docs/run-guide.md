# Run Guide

## Scope

This file is a short runtime sanity guide for local development of the
plugin runtime adapter. Benchmark-specific runtime setup lives in the
benchmark harness repository for now.

The two paths below are the current local layout on this machine, not a
stable brand-facing contract:

- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw-Bench/scripts/install_pinchbench_runtime.sh`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw-Bench/docs/pinchbench-runtime-profile.md`

Use this guide when you need to verify:

- the plugin build is the one actually running
- local host-runtime config is coherent
- the runtime path is healthy before a smoke test

## Runtime vs Source

The host runtime does not load plugin source from this repo. The effective
runtime artifact is:

```text
~/.openclaw/extensions/ecoclaw/dist/index.js
```

A successful local build does not mean the runtime is updated.

## Local Update Sequence

When iterating on the plugin locally:

1. Build the plugin package.
2. Sync `dist/` into the extension directory used by the host runtime.
3. Verify the synced runtime artifact, not only the source build output.

Typical commands:

```bash
cd /mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin
corepack pnpm build

cp dist/index.js \
  /mnt/20t/xubuqiang/.openclaw/extensions/ecoclaw/dist/index.js
cp dist/index.js.map \
  /mnt/20t/xubuqiang/.openclaw/extensions/ecoclaw/dist/index.js.map
cp openclaw.plugin.json \
  /mnt/20t/xubuqiang/.openclaw/extensions/ecoclaw/openclaw.plugin.json
```

## Verification

Byte-level check:

```bash
cmp \
  /mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/dist/index.js \
  /mnt/20t/xubuqiang/.openclaw/extensions/ecoclaw/dist/index.js
```

Config check:

```bash
OPENCLAW_CONFIG_PATH=/mnt/20t/xubuqiang/.openclaw/openclaw.json \
  openclaw config validate
```

Gateway health check:

```bash
openclaw gateway restart
tail -n 100 /mnt/20t/xubuqiang/.openclaw/logs/gateway.log
```

What you want to see in the gateway log:

- plugin active
- embedded responses proxy listening
- provider `tokenpilot/*` registered

## Environment Sanity

For local runs on this machine, keep:

```bash
export HOME=/mnt/20t/xubuqiang
export XDG_CACHE_HOME=/mnt/20t/xubuqiang/.cache
export XDG_CONFIG_HOME=/mnt/20t/xubuqiang/.config
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
```

If you are using the shared PinchBench runtime profile, prefer the benchmark
installer and profile linked at the top of this file instead of hand-editing
host-runtime config here.

## Smoke Test Order

Before a larger benchmark run:

1. `openclaw config validate`
2. restart gateway
3. run one smoke task
4. inspect plugin trace if the result looks wrong

Useful trace query:

```bash
rg 'stable_prefix_rewrite|proxy_before_call_rewrite|proxy_after_call_rewrite|tool_result_persist_applied' \
  /mnt/20t/xubuqiang/.openclaw/ecoclaw-plugin-state/task-state/trace.jsonl
```

## Fast Failure Checks

When a run looks invalid, check these in order:

1. runtime artifact mismatch
2. invalid `openclaw.json`
3. gateway did not reload the expected plugin build
4. provider registration missing
5. trace shows unexpected request rewrite or tool-result persistence

If the issue is benchmark-specific, continue in the benchmark harness rather
than expanding this file. That flow is expected to move under the main repo
later via `experiments/`.
