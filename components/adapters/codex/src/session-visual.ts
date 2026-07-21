import { loadCodexRecentTurnBindings } from "./session-state.js";
import { resolveCodexSessionTopology } from "./session-report.js";

function formatCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "0";
}

export async function renderCodexSessionVisual(
  stateDir: string,
  sessionRef?: string,
): Promise<string> {
  const topology = await resolveCodexSessionTopology(stateDir, sessionRef);
  if (!topology) return "No Codex TokenPilot session data found.";

  const bindings = await loadCodexRecentTurnBindings(stateDir, topology.sessionId, 8);
  const lines = [
    "TokenPilot Codex visual:",
    `- session: ${topology.sessionId}`,
    `- model: ${topology.latestModel ?? "unknown"}`,
    `- workspace: ${topology.workspaceHint ?? "unknown"}`,
    `- turns observed: ${topology.turnCount.toLocaleString()}`,
    `- latest response: ${topology.latestResponseId ?? "unknown"}`,
    `- previous response: ${topology.previousResponseId ?? "unknown"}`,
  ];

  if (topology.lastHookEvent) {
    lines.push(`- last hook: ${topology.lastHookEvent}`);
  }
  if (topology.lastToolName) {
    lines.push(
      `- last tool: ${topology.lastToolName} (in=${formatCount(topology.lastToolInputChars)}, out=${formatCount(topology.lastToolOutputChars)})`,
    );
  }
  if (topology.responseChain.length > 0) {
    lines.push(`- response chain: ${topology.responseChain.join(" -> ")}`);
  }
  if (bindings.length > 0) {
    lines.push("- recent turns:");
    for (const binding of bindings) {
      lines.push(
        `  • ${binding.responseId ?? "pending"} | req=${formatCount(binding.requestChars)} resp=${formatCount(binding.responseChars)} assistant=${formatCount(binding.assistantChars)} tools=${formatCount(binding.toolCallCount)}${binding.stream ? " stream" : ""}`,
      );
    }
  }

  return lines.join("\n");
}
