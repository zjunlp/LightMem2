import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { processClaudeCodeHookEvent } from "../src/hook-runtime.js";
import { renderClaudeCodeSessionVisual } from "../src/session-visual.js";

test("processClaudeCodeHookEvent records hook state and trace for Claude Code observability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-hook-"));
  try {
    const stateDir = join(dir, "state");
    const config = normalizeTokenPilotClaudeCodeConfig({
      stateDir,
    });

    await processClaudeCodeHookEvent({
      config,
      input: {
        hook_event_name: "PostToolUse",
        session_id: "sess-hook-1",
        cwd: "/repo/demo",
        tool_name: "read_file",
        tool_input: {
          path: "src/app.ts",
        },
        tool_output: "line 1\nline 2\nline 3",
      },
    });

    const snapshot = JSON.parse(
      await readFile(join(stateDir, "session-state", "sessions", "sess-hook-1.json"), "utf8"),
    ) as {
      sessionId: string;
      workspaceHint?: string;
      lastHookEvent?: string;
      lastToolName?: string;
      lastToolInputChars?: number;
      lastToolOutputChars?: number;
    };
    assert.equal(snapshot.sessionId, "sess-hook-1");
    assert.equal(snapshot.workspaceHint, "/repo/demo");
    assert.equal(snapshot.lastHookEvent, "PostToolUse");
    assert.equal(snapshot.lastToolName, "read_file");
    assert.ok((snapshot.lastToolInputChars ?? 0) > 0);
    assert.ok((snapshot.lastToolOutputChars ?? 0) > 0);

    const trace = await readFile(join(stateDir, "event-trace.jsonl"), "utf8");
    assert.match(trace, /claude_code_hook_post_tool_use/);
    assert.match(trace, /"toolName":"read_file"/);

    const visual = await renderClaudeCodeSessionVisual(stateDir, "sess-hook-1");
    assert.match(visual, /last hook: PostToolUse/);
    assert.match(visual, /last tool: read_file/);
    assert.match(visual, /workspace: \/repo\/demo/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
