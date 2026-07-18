# Sessions

A **session** is one continuous conversation with your agent host. TokenPilot tracks per-session metrics and applies context management within each session.

## Session Lifecycle

```text
SessionStart → Turns → SessionEnd
     │            │          │
     ▼            ▼          ▼
  Init state   Metrics    Finalize
  Reset stats  Active     Persist
```

TokenPilot resets its per-session state on each `SessionStart` and finalizes metrics on `SessionEnd`.

## Viewing Session Info

```bash
# Current session summary
lightmem2 report

# Specific session
lightmem2 codex session <session-id> report
lightmem2 claude-code session <session-id> report
```

## Pinning a Session

Pin a session to make it the default for subsequent commands:

```bash
lightmem2 use codex session <session-id>
lightmem2 use claude-code session <session-id>
```

Now `lightmem2 report` and `lightmem2 visual` will use the pinned session.

Clear the pin:

```bash
lightmem2 use codex session --clear
```

## Session Reports

The report shows metrics accumulated over the session:

- Total input tokens
- Cache read vs. cache miss
- Output tokens
- Estimated cost
- Per-turn breakdown (in visual inspector)

## Next

- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — understanding reports
- [CLI Reference](/user-guide/cli-reference) — session commands
- [Visual Inspector](/user-guide/visual-inspector) — browser dashboard
