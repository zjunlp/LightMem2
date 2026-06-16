# TokenPilot Component

TokenPilot is the current OpenClaw runtime component inside LightMem2.
It targets a practical long-running-session problem: prompt history grows, tool outputs accumulate, cache reuse becomes unstable, and shared sessions become increasingly expensive.

Within the current LightMem2 runtime path, TokenPilot primarily addresses this through:

- stable-prefix rewriting
- observation reduction before large tool outputs poison later turns
- lifecycle-aware canonical-history eviction for longer shared-session workflows

## Where It Fits

Use the root [README.md](../../README.md) for the fastest first-run path:

- install the repo
- install the plugin
- open a `tokenpilot/<model>` session
- verify with `/tokenpilot status`

Use this component README when you need TokenPilot-specific details:

- command surface
- package layout
- configuration reference
- runtime state layout
- debugging notes

## Component Layout

```text
components/tokenpilot/
├── README.md
└── packages/
    ├── openclaw-plugin/  # OpenClaw adapter, hooks, commands, embedded proxy
    ├── runtime-core/     # Host-agnostic runtime engine and reduction pipeline
    ├── kernel/           # Shared contracts, events, and runtime-facing types
    └── layers/
        ├── history/      # Canonical state, anchors, lifecycle bookkeeping
        ├── decision/     # Reduction and eviction analysis / policy logic
        └── memory/       # Experimental memory layer still under active development
```

## Runtime Commands

### Status And Report

```text
/tokenpilot status
/tokenpilot report
/tokenpilot help
```

### Stabilizer

```text
/tokenpilot stabilizer on
/tokenpilot stabilizer off
/tokenpilot stabilizer target developer
/tokenpilot stabilizer target user
```

### Reduction

```text
/tokenpilot reduction on
/tokenpilot reduction off
/tokenpilot reduction mode balanced
/tokenpilot reduction pass toolPayloadTrim off
```

### Eviction

```text
/tokenpilot eviction on
/tokenpilot eviction off
```

Recommended default behavior:

- keep `stabilizer` enabled
- keep `reduction` enabled
- enable `eviction` mainly for longer continuous-session workloads

## Configuration

TokenPilot is configured through your OpenClaw plugin entry, typically in:

```text
~/.openclaw/openclaw.json
```

Minimal shape:

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

### Estimator Upstream Fallback

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

## Runtime State

The current component state directory prefers:

```text
$HOME/.openclaw/tokenpilot-plugin-state/tokenpilot/
```

Useful files include:

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
  $HOME/.openclaw/tokenpilot-plugin-state/task-state/trace.jsonl
```

More package-level adapter notes live in:

- [packages/openclaw-plugin/README.md](./packages/openclaw-plugin/README.md)
- [../../docs/run-guide.md](../../docs/run-guide.md)
- [../../experiments/tokenpilot/README.md](../../experiments/tokenpilot/README.md)
