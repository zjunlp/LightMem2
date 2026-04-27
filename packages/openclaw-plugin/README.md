# TokenPilot OpenClaw Plugin

This package contains the live OpenClaw plugin runtime used by the project.

Current runtime responsibilities:

- embedded responses proxy
- stable-prefix rewriting
- request-time reduction
- tool-result persistence
- canonical history rewrite and eviction
- recovery protocol and recovery tool wiring

For a higher-level semantic map of the current module boundaries, see:

- [`docs/architecture/plugin-semantic-grouping.md`](../../docs/architecture/plugin-semantic-grouping.md)

## Install

Release-style install:

```bash
cd /path/to/tokenpilot/packages/openclaw-plugin
npm run install:release
```

This installs the packaged plugin into:

```text
~/.openclaw/extensions/ecoclaw
```

Development-style install should use source build + runtime sync instead of
mixing release and load-path installs. The current sanity workflow is:

1. build the package
2. sync the runtime artifact
3. validate OpenClaw config
4. restart gateway

See:

- [`docs/run-guide.md`](../../docs/run-guide.md)

## Build

```bash
cd /path/to/tokenpilot/packages/openclaw-plugin
corepack pnpm build
corepack pnpm typecheck
```

## Runtime Model Prefix

When the plugin is active, it registers an explicit provider namespace:

```text
tokenpilot/<model>
```

Example:

```text
tokenpilot/gpt-5.4-mini
```

## Runtime State

Default state directory:

```text
$HOME/.openclaw/ecoclaw-plugin-state/ecoclaw/
```

Useful files:

- `event-trace.jsonl`
- `provider-traffic.jsonl`
- `response-root-state.json`
- `sessions/<logical>/turns.jsonl`

## Debugging

When a run looks invalid, start with:

```bash
OPENCLAW_CONFIG_PATH=$HOME/.openclaw/openclaw.json openclaw config validate
tail -n 100 $HOME/.openclaw/logs/gateway.log
rg 'stable_prefix_rewrite|proxy_before_call_rewrite|proxy_after_call_rewrite|tool_result_persist_applied' \
  $HOME/.openclaw/ecoclaw-plugin-state/task-state/trace.jsonl
```

The runtime sanity guide lives in:

- [`docs/run-guide.md`](../../docs/run-guide.md)

## Package Scripts

Primary package scripts:

```bash
corepack pnpm build
corepack pnpm typecheck
node --import tsx --test src/**/*.test.ts
```

The package still contains a small release-helper surface under
`packages/openclaw-plugin/scripts/`. Benchmarking and evaluation flows should
stay outside this package and eventually live under the top-level
`experiments/` tree.

Script inventory:

- [`docs/architecture/plugin-script-inventory.md`](../../docs/architecture/plugin-script-inventory.md)
