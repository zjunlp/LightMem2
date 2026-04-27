# PinchBench Shared Runtime Profile

This document records the shared runtime setting used by the current
PinchBench method runs.

It is not a method algorithm note. It describes the common host runtime
profile that the experiment harness expects before per-run switches are applied, such
as:

- eviction enabled vs disabled
- estimator enabled vs disabled
- batch-turn settings
- isolated vs continual session mode

## What this shared profile installs

The current shared runtime profile installs:

- OpenClaw extension id: `ecoclaw`
- context engine slot: `ecoclaw-context`
- provider prefix: `ecoclaw/*`
- extra plugin tool: `memory_fault_recover`

These are runtime capabilities available to the harness. Individual runs may
still disable or bypass parts of the stack through benchmark-side config.

## Built-in host tools assumed by PinchBench

Current PinchBench runs assume the following built-in tools exist:

- `read`
- `edit`
- `write`
- `exec`
- `process`
- `browser`
- `sessions_list`
- `sessions_history`
- `session_status`
- `web_search`
- `web_fetch`
- `image`
- `pdf`
- `memory_search`
- `memory_get`

## Shared exec allowlist

The shared allowlist currently contains:

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

This allowlist is part of the common PinchBench runtime because several tasks
depend on directory discovery and shell-side filtering.

## Runtime environment contract

The migrated method path does not assume any specific upstream vendor.

Instead, it expects the experiment owner to provide:

- `TOKENPILOT_BASE_URL`
- `TOKENPILOT_API_KEY`
- `PINCHBENCH_MODEL_<MODEL_NAME>_BASE_URL`
- `PINCHBENCH_MODEL_<MODEL_NAME>_API_KEY`
- optional `PINCHBENCH_MODEL_<MODEL_NAME>_PROVIDER_PREFIX`
- fallback `ECOCLAW_BASE_URL`
- fallback `ECOCLAW_API_KEY`

and, when using shorthand model aliases such as `gpt-5.4-mini`:

- `PINCHBENCH_MODEL_PROVIDER_PREFIX`

The recommended place for these settings is:

- `experiments/pinchbench/.env`

If fully qualified model ids are used (for example `provider/model-name`), the
provider-prefix variable is not required.

## One-click installer

For the current external harness layout, the shared runtime is prepared by:

```bash
bash /mnt/20t/xubuqiang/EcoClaw/EcoClaw-Bench/scripts/install_pinchbench_runtime.sh
```

That installer currently:

1. builds the local plugin used by the experiment runs
2. syncs it into `~/.openclaw/extensions/ecoclaw/`
3. patches `~/.openclaw/openclaw.json` to the shared PinchBench runtime profile
4. installs the shared exec allowlist
5. validates the resulting host-runtime config

When the executable harness is consolidated into the main repository, this
entrypoint should move under `experiments/` as well.

## Scope and intent

This profile standardizes the runtime environment across PinchBench method
variants. It does not define the final per-run setting.

The benchmark entrypoints still control method-specific switches, for example:

- isolated vs continual session mode
- no-eviction vs eviction-enabled runs
- estimator batch-turn settings

## Important boundary

This profile should stay benchmark-owned.

It belongs under `experiments/` rather than plugin package docs because it
defines the shared runtime used by the experiment harness, not the public
surface of the plugin package itself.
