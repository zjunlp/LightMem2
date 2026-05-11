# PinchBench / OpenClaw Runtime Pitfalls

## 2026-05-11: PinchBench continuous run writes native session store to global home

- Symptom:
  - `PinchBench` grading reported `Transcript not found ... Sessions dir contents: []`.
  - Task execution itself succeeded and produced workspace outputs.
  - TokenPilot canonical transcript existed under `tokenpilot-plugin-state/.../canonical-state/*.json`.

- Key evidence:
  - Runtime debug inside `lib_agent.py` showed:
    - `HOME=/tmp/.../openclaw_home`
    - `OPENCLAW_CONFIG_PATH=/tmp/.../.openclaw/openclaw.json`
    - `OPENCLAW_STATE_DIR=/tmp/.../.openclaw`
  - But after the run:
    - `/tmp/.../.openclaw/agents/bench-kuaipao.../sessions/` existed but was empty.
    - `/home/xubuqiang/.openclaw/agents/bench-kuaipao.../sessions/` contained updated `sessions.json` and `*.jsonl`.

- Conclusion:
  - In this setup, `openclaw agent` / gateway session persistence still wrote the native session store to the global home, not the temporary benchmark runtime home.
  - `PinchBench` transcript loader was reading the tmp runtime home, so it saw an empty native session store.
  - This is not a file permission failure. It is a runtime state-dir / home isolation mismatch.

- Consequence:
  - Benchmark task may run successfully, but grading can fail because transcript lookup and transcript persistence point at different homes.

- Temporary debugging hook:
  - `PINCHBENCH_DEBUG_OPENCLAW_RUNTIME=true`
  - Added logging for:
    - `HOME`
    - `OPENCLAW_CONFIG_PATH`
    - `OPENCLAW_STATE_DIR`
    - resolved agent store dir
    - `openclaw config file`
    - `openclaw agents list`

- Notes:
  - Do not "fix" this by making `PinchBench` depend on TokenPilot canonical transcript as the primary source, because other methods must also use the native OpenClaw transcript path.
  - Proper fix should make native `agents/<agent>/sessions/` persist into the same tmp runtime home that benchmark reads.

## 2026-05-11: Native transcript resolution silently skipped global `~/.openclaw` candidates

- Symptom:
  - Debug logs showed the global native session store existed and contained valid `sessionId` and `sessionFile`.
  - But the main transcript loader still fell back to TokenPilot canonical transcript.

- Root cause:
  - `lib_agent.py` used `pwd.getpwuid(...)` to build real-home candidate paths.
  - The file did not import `pwd`.
  - As a result, the global `~/.openclaw/agents/<agent>/sessions` candidates were skipped in the real transcript resolution path.

- Fix:
  - Add `import pwd` in `experiments/pinchbench/dataset/scripts/lib_agent.py`.
  - Keep transcript resolution debug logging until the runtime is stable.

- Verification:
  - After the fix, logs showed:
    - `resolved sessionFile ... exists=True`
    - `Found transcript via sessionFile ...`
  - This confirmed native OpenClaw transcript lookup was working again.

## 2026-05-11: Continuous agent id reuse caused old-session contamination

- Symptom:
  - Even after native transcript lookup worked, `PinchBench` sometimes still graded against the wrong meeting content.
  - Example: Tampa council tasks produced NASA UAP-style outputs.

- Root cause:
  - Continuous runs used a stable agent id like:
    - `bench-kuaipao-gpt-5-4-mini-0001-serial`
  - The actual native session store sometimes lived in global `~/.openclaw`.
  - Old runs with the same agent id left behind `sessions.json` / `*.jsonl`, so new runs could resolve a stale `sessionFile`.

- Fix:
  - Make the continuous benchmark agent id unique by appending a timestamp.
  - Update `reset_agent_session_store()` so it clears all candidate native session stores, not only the tmp runtime store.

- Verification:
  - After the fix, the resolved native transcript moved to the current tmp run:
    - `/tmp/.../.openclaw/agents/<new-agent-id>/sessions/<current-session>.jsonl`
  - Tampa 2-task smoke run recovered to:
    - `1.7 / 2.0`
    - `86.6%`

## 2026-05-11: Do not mix unrelated meeting sources in one continuous session

- Symptom:
  - The original `run_pinchbench_meeting_turnbatch_3.sh` grouped all meeting tasks together:
    - Tampa council
    - NASA UAP
    - NTIA advisory
    - GitLab product marketing
  - This makes continuous-session results hard to interpret because long-horizon context can bleed across unrelated meetings.

- Fix / policy:
  - Split meeting runs by same-source family:
    - `tampa`
    - `tech`
    - `advisory`
    - `gov`
  - Use `PINCHBENCH_MEETING_FAMILY` and only run one family per continuous session.

- Note:
  - This is separate from stale-session contamination.
  - Even after session-store fixes, mixing heterogeneous meeting sources in one continual session is a poor experimental design.
