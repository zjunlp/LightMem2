# EcoClaw OpenClaw Plugin

Install:

```bash
openclaw plugins install ecoclaw
openclaw gateway restart
```

Optional proxy routing mode:

```bash
openclaw config set plugins.entries.ecoclaw.config.proxyBaseUrl "http://127.0.0.1:8787/v1"
openclaw config set plugins.entries.ecoclaw.config.proxyApiKey "sk-xxx"
openclaw gateway restart
```

Optional debug logs:

```bash
openclaw config set plugins.entries.ecoclaw.config.logLevel debug
openclaw gateway restart
```

Enable EcoClaw shadow runtime (recommended for current integration):

```bash
openclaw config set plugins.entries.ecoclaw.config.runtimeMode shadow
openclaw config set plugins.entries.ecoclaw.config.stateDir "/tmp/ecoclaw-plugin-state"
openclaw config set plugins.entries.ecoclaw.config.eventTracePath "/tmp/ecoclaw-plugin-state/ecoclaw/event-trace.jsonl"
openclaw config set plugins.entries.ecoclaw.config.autoForkOnPolicy true
openclaw config set plugins.entries.ecoclaw.config.cacheTtlSeconds 600
openclaw config set plugins.entries.ecoclaw.config.summaryTriggerInputTokens 20000
openclaw config set plugins.entries.ecoclaw.config.summaryTriggerStableChars 0
openclaw config set plugins.entries.ecoclaw.config.summaryRecentTurns 8
openclaw config set plugins.entries.ecoclaw.config.maxSummaryChars 6000
openclaw gateway restart
```

Local build + install test:

```bash
npm run build
openclaw plugins install .
openclaw gateway restart
```

Check runtime traces:

```bash
tail -f /tmp/ecoclaw-plugin-state/ecoclaw/event-trace.jsonl
```

Launch a lightweight web inspector for CacheTree and persisted summaries:

```bash
cd apps/lab-bench
ECOCLAW_STATE_DIR=/tmp/ecoclaw-plugin-state npm run web:cachetree
# open http://127.0.0.1:7777
```

Task-cache / session controls (prefixed to avoid OpenClaw command conflicts):

```text
/ecoclaw status
/ecoclaw cache new [task-id]
/ecoclaw session new
```

You can also type inline text commands in chat:

```text
ecoclaw status
ecoclaw cache new my-task
ecoclaw session new
```

Model semantics:
- One task-cache can contain multiple sessions.
- `cache new` starts a new task-cache (session sequence resets to s1).
- `session new` creates a new session in the current task-cache (s2, s3, ...).
