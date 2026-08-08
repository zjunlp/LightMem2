# TokenPilot Codex Adapter

This package contains the current Codex CLI adapter for the TokenPilot component.
It integrates through Codex config mutation, hook registration, and a local OpenAI-compatible Responses proxy.

This adapter explicitly binds the TokenPilot `stabilizer` and `reduction`
features. It does not advertise lifecycle eviction support. Its product
registration provides Codex state discovery to the shared CLI and Visual
surface.

For the component-level overview and shared command surface, see:

- [`components/presets/tokenpilot/README.md`](../../presets/tokenpilot/README.md)
- [`components/adapters/README.md`](../README.md)
- [`components/adapters/HOSTS.md`](../HOSTS.md)

## Supports

The Codex adapter is intentionally narrower than the OpenClaw adapter.

Supported:

- Codex provider installation into `config.toml`
- TokenPilot runtime config in `~/.codex/tokenpilot.json`
- Codex hook registration in `~/.codex/hooks.json`
- recovery MCP registration for real `memory_fault_recover`
- local Responses proxy lifecycle
- stable-prefix rewriting
- request-time reduction
- lightweight session-state tracking from proxy + hooks
- shared browser visual via `lightmem2 codex visual`
- standalone `lightmem2 codex ...` command surface
- local read-only Codex skill bridge for `status` / `report` / `doctor` / `visual`

Current limitations:

- visual inspector payload parity
- lifecycle-aware eviction controls
- `mode aggressive`
- native runtime-managed in-host commands

## Install

For a release archive, extract it and run the bundled installer directly:

```bash
node /path/to/package/dist/install-codex.js
```

The release archive is self-contained: its hooks, recovery MCP server,
`lightmem2` command, and `tokenpilot-codex` command all run from the extracted
package directory. Keep that directory in place after installation.

For a source checkout, build the adapter first:

Build the adapter:

```bash
cd /path/to/LightMem2
npm --prefix components/adapters/codex run build
```

If your Codex files are not under the default `~/.codex`, set:

```bash
export CODEX_CONFIG_PATH="/path/to/config.toml"
export CODEX_HOOKS_CONFIG_PATH="/path/to/hooks.json"
export TOKENPILOT_CODEX_CONFIG="/path/to/tokenpilot.json"
```

Then install:

```bash
cd /path/to/LightMem2
npm --prefix components/adapters/codex run install:codex
```

If `lightmem2` is not found after install, make sure `~/.local/bin` is on your `PATH`.

The installer will:

- keep the current active `model_provider`
- repoint that active provider's `base_url` to the local TokenPilot proxy
- persist the original upstream provider config into `~/.codex/tokenpilot.json`
- register a `tokenpilot_memory_fault_recover` MCP server in Codex config
- write a conservative `startup_timeout_sec` for the recovery MCP server
- write TokenPilot runtime config
- register TokenPilot hooks for `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop`
- install read-only Codex skill bridge entries under the local Codex skills directory
- run a post-install MCP startup probe and report degraded mode if recovery MCP is still unavailable

The installed Codex skill bridge currently creates these explicit skills:

- `lightmem2-status`
- `lightmem2-report`
- `lightmem2-doctor`
- `lightmem2-visual`

These are host entry points, not a separate runtime implementation. They call
the existing `lightmem2 codex ...` CLI surface underneath.

This install mode is intentionally session-preserving: Codex keeps using the
same provider name it was already using, so existing thread history does not
disappear behind a separate `tokenpilot` provider bucket.

## Verify

You can run the adapter doctor immediately after install:

```bash
cd /path/to/LightMem2
npm --prefix components/adapters/codex run doctor:codex
```

Then use the first real-session path:

1. Start Codex normally.
2. If Codex asks you to review or trust the TokenPilot hooks, approve them.
3. Open a new Codex session so `SessionStart` can start the local proxy.
4. In another terminal, verify through the shared CLI:

```bash
lightmem2 codex status
lightmem2 codex doctor
lightmem2 codex report
lightmem2 codex mode normal
lightmem2 codex reduction status
```

Expected first-run shape:

- `lightmem2 codex doctor` reports `proxy healthy: yes`
- `lightmem2 codex status` shows `stabilizer` and `reduction` enabled
- after a few turns, `lightmem2 codex report` no longer says `No TokenPilot session stats yet.`

Once installed, Codex can use the real internal recovery tool named
`memory_fault_recover` through the registered MCP server. Recovery hints in
trimmed payloads are no longer just protocol text.

### Offline context-rebase smoke

The response-chain rebase path has a credential-free smoke command for local
development and CI:

```bash
npm --prefix components/adapters/codex run smoke:context-rebase:codex -- \
  --mode=mock \
  --output-dir=/path/to/sanitized-evidence
```

It starts a temporary loopback Responses upstream and verifies encrypted
reasoning replay, function call/output closure, sentinel eviction and
retention, five turns on the new response chain, proxy restart, one-attempt
fallback with cooldown, all eight stabilizer/reduction/rewrite combinations,
and estimated rebase accounting including the break-even turn.

The command never reads an API key. Its evidence is explicitly marked
`mode: mock` and omits raw prompts, headers, response IDs, and encrypted
reasoning payloads. It does not replace real-provider validation or
provider-observed usage and break-even evidence.

### Opt-in provider context-rebase smoke

The same command exposes a separate, explicit provider mode:

```bash
npm --prefix components/adapters/codex run smoke:context-rebase:codex -- \
  --mode=provider \
  --model=gpt-5.4-mini \
  --output-dir=/path/to/sanitized-evidence
```

Provider mode reads `OPENAI_API_KEY` and `OPENAI_BASE_URL` from the process
environment or `<initial cwd>/.env`; `--credentials-file` can select another
ignored env file. There is no CLI argument for the key. The mode first verifies
exact encrypted-reasoning and function-call/output replay, then compares a
control chain with a five-turn rebase chain and restarts the proxy before turn
three. It writes a v2 artifact only if the Responses endpoint, capability v2
journal, rebase commit ordering, sentinel checks, exact payload digest, tool
closure, response links, restart mapping, and provider usage gates all pass.

Evidence contains only safe endpoint/model labels, an endpoint digest,
booleans, counts, item types, payload length/digest, and provider usage totals.
It never contains the API key, raw prompts, response IDs, encrypted payloads,
headers, or raw provider error bodies. Authentication and unrelated schema
failures are not retried; only 429 and 5xx receive two bounded retries. If a
provider explicitly rejects `previous_response_id`, the proxy retries once with
journal-derived stateless history, forces `store: false`, requests encrypted
reasoning state, and caches the transport decision by provider/model/endpoint.
Later turns use stateless replay directly while preserving every supported
response output item. A 2xx response that omits explicitly requested encrypted
reasoning receives at most two transport-level repair retries. Journal parent
links always follow the client request (including an explicit root), never an
inconsistent provider echo. Reused provider response IDs remain ordered journal
occurrences, so a restart does not collapse a valid logical chain.

Context-history journal writers use a session-scoped cross-process lock. A
successful append is one complete JSONL record followed by `sync`; concurrent
request and response writers cannot interleave their records. If a crash leaves
one unterminated JSON/UTF-8 suffix after an otherwise canonical journal, the
next append or effective-history restart read truncates only that suffix under
the same lock and syncs the file. A complete canonical final record that only
lacks its newline is preserved and normalized. Invalid canonical records,
middle corruption, and read/write uncertainty still fail closed so the proxy
bypasses rewriting instead of guessing history. Recovery evidence exposes only
a reason, byte count, and SHA-256 digest, never the discarded bytes. This is
crash-truncated tail recovery, not power-loss-level transactional append
semantics.

Provider replay compatibility is evaluated separately from structural
replayability. A complete tool closure or exact encrypted payload only makes an
item a replay candidate; it does not prove that the selected provider and model
accept that item. Capability journal v2 keys observations by provider, model,
Responses wire/API mode, a SHA-256 endpoint identity, item type, and item schema
version, and expires observations after a bounded TTL.

The default `contextRewrite.providerCompatibilityProbe` value is
`real_provider`. Unknown item compatibility is learned from the actual
rebased/stateless request; an explicit rejection is cached, while a successful
replay records support. `disabled` keeps the conservative bypass behavior and
`mock_fixture` is reserved for fixtures. Mock evidence can drive mock tests but
is never presented as real-provider verification. Explicit item-schema
rejection is scoped to the named item type; encrypted-content lineage/expiry
rejection is scoped to the exact payload digest; authentication, rate-limit,
server, network, and ambiguous multi-item failures do not poison the capability
cache. `program`, `program_output`, and program-issued tool outputs retain their
fingerprint, status, and exact `caller` relationship. Doctor and session reports
label the evidence source and whether each observation is active or expired.

If install finishes in degraded MCP mode, Codex stable-prefix and reduction remain usable; only the real `memory_fault_recover` tool path is unavailable until MCP startup succeeds.

If doctor still reports `proxy healthy: no` after hooks are trusted and a new session has started, use the daemon fallback:

```bash
tokenpilot-codex status
tokenpilot-codex start
tokenpilot-codex stop
```

## Commands

Codex command surface:

```bash
lightmem2 codex status
lightmem2 codex report
lightmem2 codex doctor
lightmem2 codex visual
lightmem2 codex mode conservative
lightmem2 codex mode normal
lightmem2 codex stabilizer on
lightmem2 codex stabilizer off
lightmem2 codex stabilizer target developer
lightmem2 codex stabilizer target user
lightmem2 codex reduction on
lightmem2 codex reduction off
lightmem2 codex reduction mode light
lightmem2 codex reduction mode balanced
lightmem2 codex reduction pass toolPayloadTrim off
```

Supported reduction passes:

- `readStateCompaction`
- `toolPayloadTrim`
- `htmlSlimming`
- `execOutputTruncation`
- `agentsStartupOptimization`

Not supported:

- `lightmem2 codex settings ...`
- `lightmem2 codex eviction ...`
- `lightmem2 codex mode aggressive`
- `lightmem2 codex stabilizer hook ...`

## Report And Visual

`lightmem2 codex report` and `lightmem2 codex visual` intentionally serve different purposes:

- `report`: savings-oriented summary from `ux-effects`
- `visual`: shared browser visual surface preselected to the current Codex host and session

Current visual data includes:

- stability snapshots
- reduction snapshots
- recent cache-audit summaries
- browser-side host and session selection through the shared visual surface

Codex still persists a lightweight observability layer from proxy + hook traces, but `lightmem2 codex visual` now opens the shared browser visual surface rather than a text-only view.

## Runtime Files

The current adapter writes state under:

```text
~/.codex/tokenpilot-state/tokenpilot/
```

Useful files:

- `tokenpilot-codex.pid`
- `tokenpilot-codex.log`
- `event-trace.jsonl`
- `session-state/latest.json`
- `session-state/sessions/<session>.json`
- `session-state/bindings/<session>.jsonl`
- `ux-effects/latest.json`
- `ux-effects/sessions/<session>.json`

## Debugging

Useful checks:

```bash
cat ~/.codex/tokenpilot.json
cat ~/.codex/hooks.json
rg "model_provider|base_url" ~/.codex/config.toml
rg "mcp_servers.tokenpilot_memory_fault_recover" ~/.codex/config.toml
npm --prefix components/adapters/codex run doctor:codex
tokenpilot-codex status
```

Expected install shape:

- root `model_provider` stays on your original Codex provider, such as `OPENAI`
- that provider's `base_url` is rewritten to `http://127.0.0.1:<port>/v1`
- the real upstream base URL is stored in `~/.codex/tokenpilot.json`

If Codex reports that hooks need review, trust the TokenPilot hooks in Codex, open a new session, and rerun the doctor.

If Codex displays `Stop hook (failed)` or `PostToolUse hook (failed)` after a
repository reorganization, rebuild and reinstall the adapter so
`~/.codex/hooks.json` points at the current handler:

```bash
npm --prefix components/adapters/codex run build
npm --prefix components/adapters/codex run install:codex
```

The expected handler path is
`components/adapters/codex/dist/hooks-handler.js`. The handler uses bounded
iterative traversal for large or deeply nested tool results, and observation
write failures are best-effort so they do not fail a successful Codex tool
call.

## Package Scripts

Primary package scripts:

```bash
npm --prefix components/adapters/codex run build
npm --prefix components/adapters/codex run typecheck
npm --prefix components/adapters/codex test
npm --prefix components/adapters/codex run smoke:context-rebase:codex -- --mode=mock
npm --prefix components/adapters/codex run install:codex
npm --prefix components/adapters/codex run doctor:codex
npm --prefix components/adapters/codex run pack:release
```

`pack:release` is the Linux/CI Bash path. On Windows, build the Codex adapter,
shared CLI, and MCP packages first, then use `pack:release:portable`; it creates
the same minimal archive through a temporary directory without requiring WSL.
