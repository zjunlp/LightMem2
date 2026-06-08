<h1 align="center">TokenPilot</h1>

<p align="center">
  Cache-efficient context management for long-running OpenClaw agents
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Runtime-OpenClaw-green" alt="runtime">
  <img src="https://img.shields.io/badge/Plugin-TokenPilot-blue" alt="plugin">
  <img src="https://img.shields.io/badge/Package%20Manager-pnpm-informational" alt="pnpm">
  <img src="https://img.shields.io/badge/License-MIT-brightgreen" alt="license">
</p>

<p align="center">
  Stable Prefix, Observation Reduction, and Lifecycle-Aware Eviction for practical long-session agents
</p>

---

**TokenPilot** is an OpenClaw runtime plugin for reducing token cost in long-running agent sessions.
It focuses on a practical deployment problem: once an agent keeps working in one shared session, prompt history grows, tool outputs accumulate, and cache reuse becomes unstable.

TokenPilot addresses this with three runtime mechanisms:

- **Stable Prefix**: keep the reusable prompt prefix structurally stable across turns
- **Observation Reduction**: trim bulky tool outputs before they pollute later requests
- **Lifecycle-Aware Eviction**: remove cold completed tasks from canonical history when needed

This repository is organized first as a usable open-source project.
The main goal of this README is to help a new user install the plugin and run it successfully.

<span id='news'/>

## 📢 News

- **[2026-06-08]** TokenPilot is released.

<span id='installation'/>

## 🔧 Installation

### Before You Begin

You need:

- **Node.js 20+**
- **pnpm** via `corepack`
- **OpenClaw** installed and already runnable on your machine
- a working OpenClaw config at `~/.openclaw/openclaw.json`
- at least one provider/model in OpenClaw that can already answer normally

If OpenClaw itself is not working yet, fix that first. TokenPilot is a runtime plugin on top of OpenClaw, not a standalone agent framework.

The installer expects the `openclaw` command to already be available in your shell.
By default it uses the standard OpenClaw home and config location under `~/.openclaw`, unless you override that with environment variables such as `TOKENPILOT_OPENCLAW_HOME` or `OPENCLAW_CONFIG_PATH`.

### Installation Steps

```bash
git clone https://github.com/Xubqpanda/TokenPilot.git
cd TokenPilot
corepack enable
pnpm install
pnpm build
pnpm plugin:install:release
```

The installer will:

- package the release plugin
- install it into `~/.openclaw/extensions/tokenpilot`
- update `~/.openclaw/openclaw.json`
- enable the TokenPilot plugin entry
- try to restart the OpenClaw gateway automatically

If you only want to package the plugin without installing it:

```bash
pnpm plugin:pack:release
```

<span id='quickstart'/>

## ⚡ Quick Start

### 1. Use the TokenPilot Model Namespace

When the plugin is active, OpenClaw will expose models under:

```text
tokenpilot/<model>
```

For example:

```text
tokenpilot/gpt-5.4-mini
```

For a first run, use a `tokenpilot/...` model instead of your original provider model.

### 2. Verify It in a Real Session

The simplest manual verification flow is:

1. Start or restart OpenClaw.
2. Open a session with a `tokenpilot/<model>` model.
3. Run:

```text
/tokenpilot status
```

You should see a status block similar to:

- plugin entry enabled
- config enabled
- stabilizer enabled
- reduction enabled

For a fuller runtime summary, run:

```text
/tokenpilot report
```

After a few turns, TokenPilot state is usually written under:

```text
~/.openclaw/tokenpilot-plugin-state/tokenpilot/
```

Useful files include:

- `event-trace.jsonl`
- `provider-traffic.jsonl`
- `forwarded-inputs/`

### 3. Run the Built-In Smoke Test

```bash
bash docs/scripts/smoke_isolated_gateway.sh
```

Before running it, set your upstream provider info:

```bash
export TOKENPILOT_API_KEY="your_api_key"
export TOKENPILOT_BASE_URL="https://your-openai-compatible-endpoint/v1"
```

If your machine does **not** need an upstream HTTP proxy, also clear:

```bash
export TOKENPILOT_UPSTREAM_HTTP_PROXY=
export TOKENPILOT_UPSTREAM_HTTPS_PROXY=
```

The smoke script will:

- create a temporary OpenClaw runtime home
- wire TokenPilot as a local proxy provider
- start a local gateway
- send a minimal `Reply with exactly: pong` request

<span id='architecture'/>

## 🏗️ Architecture

TokenPilot sits between OpenClaw and your upstream model provider.
The plugin layer receives session traffic, normalizes it, and routes the request through runtime-core before forwarding it upstream.

Its public behavior is built around three runtime mechanisms:

### 1. Stable Prefix

TokenPilot rewrites volatile runtime fields so consecutive requests share a more stable cacheable prefix.
This improves provider-side cache reuse.

### 2. Observation Reduction

TokenPilot applies reduction passes to noisy or oversized payloads, including:

- repeated read deduplication
- tool payload trimming
- HTML slimming
- execution output truncation
- format/path cleanup

If truncation removes something important, the plugin can preserve recovery metadata so the agent can fetch the full content later.

### 3. Lifecycle-Aware Eviction

For continuous multi-task sessions, TokenPilot tracks task lifecycle states such as:

- `active`
- `completed`
- `evictable`

This allows the runtime to remove cold completed tasks instead of replaying them forever.

The most important source directories for open-source users are:

- `packages/openclaw-plugin/`
- `packages/runtime-core/`

<span id='examples'/>

## 💡 Examples

### Runtime Commands

TokenPilot exposes a small command surface inside OpenClaw sessions.

Status and report:

```text
/tokenpilot status
/tokenpilot report
/tokenpilot help
```

Stabilizer:

```text
/tokenpilot stabilizer on
/tokenpilot stabilizer off
/tokenpilot stabilizer target developer
/tokenpilot stabilizer target user
```

Reduction:

```text
/tokenpilot reduction on
/tokenpilot reduction off
/tokenpilot reduction mode balanced
/tokenpilot reduction pass toolPayloadTrim off
```

Eviction:

```text
/tokenpilot eviction on
/tokenpilot eviction off
```

For most users, the recommended default is:

- keep **stabilizer** on
- keep **reduction** on
- leave **eviction** for longer continuous workflows or benchmark reproduction

<span id='configuration'/>

## ⚙️ Configuration

TokenPilot is configured through your OpenClaw config, typically:

```text
~/.openclaw/openclaw.json
```

The plugin entry usually lives under:

```json
{
  "plugins": {
    "entries": {
      "tokenpilot": {
        "enabled": true,
        "config": {
          "...": "..."
        }
      }
    }
  }
}
```

### Minimal Example

```json
{
  "plugins": {
    "entries": {
      "tokenpilot": {
        "enabled": true,
        "config": {
          "enabled": true,
          "proxyAutostart": true,
          "proxyPort": 17667,
          "stateDir": "~/.openclaw/tokenpilot-plugin-state",
          "modules": {
            "stabilizer": true,
            "policy": true,
            "reduction": true,
            "eviction": false
          },
          "hooks": {
            "beforeToolCall": true,
            "dynamicContextTarget": "developer"
          },
          "reduction": {
            "engine": "layered",
            "triggerMinChars": 2200,
            "maxToolChars": 1200
          }
        }
      }
    }
  }
}
```

### Common Configuration

| Key | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `enabled` | `boolean` | `true` | Enable TokenPilot plugin hooks. |
| `proxyBaseUrl` | `string` | unset | OpenAI-compatible upstream base URL used by the embedded proxy. |
| `proxyApiKey` | `string` | unset | API key used with `proxyBaseUrl`. |
| `stateDir` | `string` | `~/.openclaw/tokenpilot-plugin-state` | Root directory for TokenPilot runtime state. |
| `proxyAutostart` | `boolean` | `true` after install | Whether the embedded responses proxy starts automatically. |
| `proxyPort` | `number` | `17667` | Local port used by the embedded proxy. |
| `hooks.beforeToolCall` | `boolean` | `true` after install | Enable before-tool-call safety/default injection. |
| `hooks.dynamicContextTarget` | `string` | `developer` | Where dynamic context is injected. Supported values: `developer`, `user`. |
| `modules.stabilizer` | `boolean` | `true` | Enable stable-prefix related runtime behavior. |
| `modules.policy` | `boolean` | `true` | Enable policy/decision plumbing. |
| `modules.reduction` | `boolean` | `true` | Enable observation reduction execution. |
| `modules.eviction` | `boolean` | `false` | Enable lifecycle-aware eviction execution. |
| `reduction.engine` | `string` | `layered` | Reduction engine. Current public value is `layered`. |
| `reduction.triggerMinChars` | `number` | `2200` | Minimum chars before reduction candidate generation is triggered. |
| `reduction.maxToolChars` | `number` | `1200` | Target maximum chars for trimmed tool payloads. |
| `reduction.passes.repeatedReadDedup` | `boolean` | `true` | Deduplicate repeated reads. |
| `reduction.passes.toolPayloadTrim` | `boolean` | `true` | Trim oversized tool payloads. |
| `reduction.passes.htmlSlimming` | `boolean` | `true` | Compact noisy HTML content. |
| `reduction.passes.execOutputTruncation` | `boolean` | `true` | Truncate long execution outputs. |
| `reduction.passes.agentsStartupOptimization` | `boolean` | `true` | Apply agent startup optimization pass. |
| `reduction.passes.memoryFaultRecovery` | `boolean` | `false` | Enable recovery-aware reduction fallback behavior. |
| `eviction.enabled` | `boolean` | `false` | Enable task-level canonical history eviction. |
| `taskStateEstimator.enabled` | `boolean` | `false` | Enable the estimator used by lifecycle-aware eviction. |
| `taskStateEstimator.baseUrl` | `string` | inherited from upstream when unset | OpenAI-compatible base URL for the estimator model. |
| `taskStateEstimator.apiKey` | `string` | inherited from upstream when unset | API key for estimator requests. |
| `taskStateEstimator.model` | `string` | inherited from upstream when unset | Model name used by the estimator. |
| `taskStateEstimator.batchTurns` | `number` | `5` | Minimum turns before running one estimator update. |
| `taskStateEstimator.evictionLookaheadTurns` | `number` | `3` | Lookahead horizon for completed-to-evictable decisions. |
| `taskStateEstimator.lifecycleMode` | `string` | `coupled` | Supported values: `coupled`, `decoupled`. |
| `taskStateEstimator.evidenceMode` | `string` | `three_state` | Supported values: `three_state`, `two_state`. |
| `taskStateEstimator.inputMode` | `string` | `completed_summary_plus_active_turns` | Supported values: `sliding_window`, `completed_summary_plus_active_turns`. |
| `ux.details` | `boolean` | `false` | Show module-level details in TokenPilot report surfaces. |
 
### Advanced Configuration

| Key | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `logLevel` | `string` | `info` | Plugin log verbosity. Supported values: `info`, `debug`. |
| `debugTapProviderTraffic` | `boolean` | `false` | Debug-only provider traffic tap. |
| `debugTapPath` | `string` | unset | Optional output path for tapped provider traffic. |
| `proxyMode.pureForward` | `boolean` | `false` | Disable proxy-side rewriting and only forward traffic. |
| `hooks.toolResultPersist` | `boolean` | `false` | Persist oversized tool results as external artifacts. |
| `reduction.passOptions.formatSlimming.enabled` | `boolean` | `true` | Enable lightweight formatting cleanup. |
| `reduction.passOptions.formatCleaning.enabled` | `boolean` | `true` | Enable additional formatting cleanup. |
| `reduction.passOptions.pathTruncation.enabled` | `boolean` | `true` | Enable path shortening. |
| `reduction.passOptions.imageDownsample.enabled` | `boolean` | `true` | Enable image downsampling. |
| `reduction.passOptions.lineNumberStrip.enabled` | `boolean` | `true` | Enable line-number removal for noisy reads. |
| `eviction.policy` | `string` | `noop` | Eviction policy. Supported values: `noop`, `lru`, `lfu`, `gdsf`, `model_scored`. |
| `eviction.maxCandidateBlocks` | `number` | `128` after install | Upper bound on eviction candidates. |
| `eviction.minBlockChars` | `number` | `256` after install | Minimum block size considered for eviction. |
| `eviction.replacementMode` | `string` | `pointer_stub` | How evicted content is replaced. Supported values: `pointer_stub`, `drop`. |
| `taskStateEstimator.requestTimeoutMs` | `number` | `60000` | Estimator request timeout. |
| `taskStateEstimator.completedSummaryMaxRawTurns` | `number` | `0` | Optional cap for raw turns before completed-task summaries are used. |
| `taskStateEstimator.evictionPromotionPolicy` | `string` | `fifo` | Promotion policy used in decoupled mode. |
| `taskStateEstimator.evictionPromotionHotTailSize` | `number` | `1` | Number of most-recent completed tasks kept hot before promotion. |
| `contextEngine.enabled` | `boolean` | `true` after install | Enable canonical-state context pruning logic. |
| `contextEngine.pruneThresholdChars` | `number` | `100000` | Prune older tool results when canonical chars exceed this threshold. |
| `contextEngine.keepRecentToolResults` | `number` | `5` | Number of recent tool results to keep unpruned. |
| `contextEngine.placeholder` | `string` | `[pruned]` | Placeholder used after canonical pruning. |
| `memory.enabled` | `boolean` | `false` | Enable procedural memory features. |
| `memory.autoDistill` | `boolean` | `false` | Distill evicted tasks into skills asynchronously. |
| `memory.distillerType` | `string` | `prompting` | Supported values: `prompting`, `autoskill`, `ctx2skill`. |
| `memory.batchSize` | `number` | `2` | Background distillation batch size. |
| `memory.topK` | `number` | `0` | Maximum number of retrieved skills injected per request. |
| `memory.injectAsSystemHint` | `boolean` | `false` | Inject retrieved skills as a system hint instead of a user-prefix. |

If you only want a practical starting point, configure these first:

- `enabled`
- `proxyBaseUrl`
- `proxyApiKey`
- `modules.stabilizer`
- `modules.reduction`
- `modules.eviction`

If you enable `taskStateEstimator`, you can either configure its `baseUrl`, `apiKey`, and `model` explicitly, or leave them unset and let TokenPilot fall back to the currently detected upstream provider and its first mirrored model.

Minimal example with upstream fallback:

```json
{
  "plugins": {
    "entries": {
      "tokenpilot": {
        "config": {
          "taskStateEstimator": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

If you need the full raw schema, see:

- [packages/openclaw-plugin/openclaw.plugin.json](./packages/openclaw-plugin/openclaw.plugin.json)

Useful related docs:

- [docs/README.md](./docs/README.md)
- [packages/openclaw-plugin/README.md](./packages/openclaw-plugin/README.md)

Troubleshooting notes:

- If `tokenpilot/<model>` does not appear, validate and restart OpenClaw:

```bash
OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json" openclaw config validate
```

- If the plugin is installed but you still used the original model, switch to a `tokenpilot/<model>` model key.
