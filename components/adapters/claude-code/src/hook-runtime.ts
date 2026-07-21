import { appendClaudeCodeTrace } from "./trace.js";
import { loadTokenPilotClaudeCodeConfig, type TokenPilotClaudeCodeConfig } from "./config.js";
import { upsertClaudeCodeSessionSnapshot } from "./session-state.js";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findFirstString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = stringValue(obj[key]);
    if (direct) return direct;
  }
  for (const child of Object.values(obj)) {
    if (!child || typeof child !== "object") continue;
    const nested = findFirstString(child, keys);
    if (nested) return nested;
  }
  return undefined;
}

function estimateTextChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value == null) return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateTextChars(item), 0);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .reduce<number>((sum, item) => sum + estimateTextChars(item), 0);
  }
  return String(value).length;
}

function extractToolEvent(input: Record<string, unknown>): {
  toolName?: string;
  toolInputChars: number;
  toolOutputChars: number;
} {
  const toolName = findFirstString(input, ["tool_name", "toolName", "name", "tool"]);
  const output =
    input.tool_output ?? input.toolOutput ?? input.output ?? input.result ?? input.tool_result ?? input.toolResult;
  const toolInput =
    input.tool_input ?? input.toolInput ?? input.input ?? input.arguments ?? input.args;
  return {
    toolName,
    toolInputChars: estimateTextChars(toolInput),
    toolOutputChars: estimateTextChars(output),
  };
}

function workspaceHintFromEvent(input: Record<string, unknown>): string | undefined {
  return findFirstString(input, [
    "cwd",
    "workspace",
    "workspace_path",
    "workspacePath",
    "project_root",
    "projectRoot",
  ]);
}

function sessionIdFromEvent(input: Record<string, unknown>): string | undefined {
  return findFirstString(input, ["session_id", "sessionId", "thread_id", "threadId", "conversationId"]);
}

export async function processClaudeCodeHookEvent(params: {
  input: Record<string, unknown>;
  config?: TokenPilotClaudeCodeConfig;
  configPath?: string;
}): Promise<void> {
  const config = params.config ?? await loadTokenPilotClaudeCodeConfig(params.configPath);
  if (!config.enabled) return;

  const input = params.input;
  const hookEventName = findFirstString(input, ["hook_event_name", "hookEventName", "event", "eventName"]) ?? "unknown";
  const sessionId = sessionIdFromEvent(input);
  const workspaceHint = workspaceHintFromEvent(input);
  const tool = extractToolEvent(input);

  if (sessionId) {
    await upsertClaudeCodeSessionSnapshot(config.stateDir, sessionId, {
      workspaceHint,
      lastHookEvent: hookEventName,
      lastToolName: tool.toolName,
      lastToolInputChars: tool.toolInputChars,
      lastToolOutputChars: tool.toolOutputChars,
    });
  }

  const stageByEvent: Record<string, string> = {
    SessionStart: "claude_code_hook_session_start",
    PreToolUse: "claude_code_hook_pre_tool_use",
    PostToolUse: "claude_code_hook_post_tool_use",
    Stop: "claude_code_hook_stop",
    SessionEnd: "claude_code_hook_session_end",
  };

  await appendClaudeCodeTrace(config.stateDir, {
    stage: stageByEvent[hookEventName] ?? "claude_code_hook_observed",
    hookEventName,
    sessionId: sessionId ?? null,
    workspaceHint: workspaceHint ?? null,
    toolName: tool.toolName ?? null,
    toolInputChars: tool.toolInputChars,
    toolOutputChars: tool.toolOutputChars,
    charsObserved: estimateTextChars(input),
  });
}
