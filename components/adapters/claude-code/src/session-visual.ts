import { loadClaudeCodeRecentTurnBindings } from "./session-state.js";
import { resolveClaudeCodeSessionTopology } from "./session-report.js";

function formatCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "0";
}

export async function renderClaudeCodeSessionVisual(
  stateDir: string,
  sessionRef?: string,
): Promise<string> {
  const topology = await resolveClaudeCodeSessionTopology(stateDir, sessionRef);
  if (!topology) return "No Claude Code TokenPilot session data found.";

  const bindings = await loadClaudeCodeRecentTurnBindings(stateDir, topology.sessionId, 8);
  const lines = [
    "TokenPilot Claude Code visual:",
    `- session: ${topology.sessionId}`,
    `- model: ${topology.latestModel ?? "unknown"}`,
    `- workspace: ${topology.workspaceHint ?? "unknown"}`,
    `- turns observed: ${topology.turnCount.toLocaleString()}`,
    `- latest response: ${topology.latestResponseId ?? "unknown"}`,
    `- previous response: ${topology.previousResponseId ?? "unknown"}`,
    `- latest request chars: ${formatCount(topology.requestChars)}`,
    `- latest response chars: ${formatCount(topology.responseChars)}`,
    `- latest assistant chars: ${formatCount(topology.assistantChars)}`,
    `- latest reduction savings: ${formatCount(topology.reductionSavedChars)}`,
  ];

  if (topology.lastHookEvent) {
    lines.push(`- last hook: ${topology.lastHookEvent}`);
  }
  if (topology.lastToolName) {
    lines.push(`- last tool: ${topology.lastToolName}`);
    lines.push(`- last tool input chars: ${formatCount(topology.lastToolInputChars)}`);
    lines.push(`- last tool output chars: ${formatCount(topology.lastToolOutputChars)}`);
  }

  if (topology.responseChain.length > 0) {
    lines.push(`- response chain: ${topology.responseChain.join(" -> ")}`);
  }
  if (bindings.length > 0) {
    lines.push("- recent turns:");
    for (const binding of bindings) {
      lines.push(
        `  • ${binding.responseId ?? "pending"} | req=${formatCount(binding.requestChars)} resp=${formatCount(binding.responseChars)} assistant=${formatCount(binding.assistantChars)} saved=${formatCount(binding.reductionSavedChars)}${binding.stream ? " stream" : ""}`,
      );
    }
  }

  return lines.join("\n");
}
