# EcoClaw OpenClaw Plugin

This plugin adds a runtime optimization layer to OpenClaw and registers an
explicit provider namespace:

- `ecoclaw/<model>` (example: `ecoclaw/gpt-5.4`)

It includes:

- Embedded responses proxy
- Stable-prefix cache reuse for OpenAI Responses-compatible providers
- Cache/summary/compaction decision modules
- Session topology + `/ecoclaw` command controls
- JSONL event tracing for analysis

## 1) Install And Enable

```bash
cd packages/openclaw-plugin
npm run build
openclaw plugins install .
```

Recommended trusted plugin allowlist:

```bash
openclaw config set plugins.allow "[\"ecoclaw\"]"
openclaw config set plugins.entries.ecoclaw.enabled true
openclaw gateway restart
```

## 2) Supported Plugin Config

```bash
openclaw config set plugins.entries.ecoclaw.config.stateDir "$HOME/.openclaw/ecoclaw-plugin-state"
openclaw config set plugins.entries.ecoclaw.config.proxyAutostart true
openclaw config set plugins.entries.ecoclaw.config.proxyPort 17667
openclaw gateway restart
```

Optional debug:

```bash
openclaw config set plugins.entries.ecoclaw.config.logLevel debug
openclaw config set plugins.entries.ecoclaw.config.debugTapProviderTraffic true
openclaw config set plugins.entries.ecoclaw.config.debugTapPath "$HOME/.openclaw/ecoclaw-plugin-state/ecoclaw/provider-traffic.jsonl"
openclaw gateway restart
```

Valid config keys are only:

- `enabled`
- `logLevel`
- `proxyBaseUrl`
- `proxyApiKey`
- `stateDir`
- `debugTapProviderTraffic`
- `debugTapPath`
- `proxyAutostart`
- `proxyPort`

## 3) Model Selection

In OpenClaw, use explicit EcoClaw provider models:

```text
ecoclaw/gpt-5.4
```

The plugin auto-starts an embedded proxy and syncs explicit model aliases into
`~/.openclaw/openclaw.json` when possible.

## 4) How Cache Reuse Works

For the default Responses path, EcoClaw does not rely on `previous_response_id`
to force cross-task reuse. The stable hit comes from keeping the cacheable
prefix byte-identical across requests:

- Normalize dynamic timestamp prefixes like `[Fri 2026-03-27 14:08 GMT+8]` to `[<TS>]`, then append the real timestamp back at the tail as metadata
- Compute one stable `prompt_cache_key` from normalized model + instructions + developer prompt + tool fingerprint
- Force `prompt_cache_retention = "24h"` on outbound `/responses` calls

Once one request warms that normalized prefix, later same-session turns and
forked first turns land in the same upstream cache partition and can reuse it.

## 5) Commands

Use slash commands in TUI:

```text
/ecoclaw help              # show command usage and examples
/ecoclaw status            # current binding (sessionKey/task/logical/seq)
/ecoclaw cache list        # list known task-cache workspaces
/ecoclaw cache new <id>    # create/switch current task-cache
/ecoclaw cache delete <id> # delete task-cache and purge local state
/ecoclaw session new       # create next logical session in current task-cache
```

You can also type inline form (`ecoclaw status`), but slash form is preferred.

## 6) Runtime Files

Default state directory:

```text
$HOME/.openclaw/ecoclaw-plugin-state/ecoclaw/
```

Important files:

- `event-trace.jsonl`: per-turn pipeline events
- `provider-traffic.jsonl`: provider tap debug log (if enabled)
- `response-root-state.json`: root-link metadata cache
- `sessions/<logical>/turns.jsonl`: logical session turn history

## 7) Acceptance Test

Run the built-in cache acceptance harness:

```bash
cd packages/openclaw-plugin
npm run acceptance:cache
```

Useful variants:

```bash
TARGET_CLEAN_RUNS=1 bash ./scripts/cache_acceptance.sh multi
TARGET_CLEAN_RUNS=1 bash ./scripts/cache_acceptance.sh fork
```

The harness:

- seeds a minimal Responses session scaffold
- verifies same-session bridge -> task1 -> task2 -> task3 cache reuse
- verifies bridge -> fork_A / fork_B / fork_C first-turn reuse
- retries noisy runs and requires cache-read thresholds before reporting success

Outputs are written under `packages/openclaw-plugin/.tmp/cache-acceptance/`.

## 8) Dashboard

```bash
cd apps/lab-bench
ECOCLAW_STATE_DIR="$HOME/.openclaw/ecoclaw-plugin-state" npm run web:cachetree
```

Open `http://127.0.0.1:7777` to inspect runtime decisions and compaction ROI.
