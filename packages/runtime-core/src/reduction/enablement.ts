export type ReductionPassToggles = {
  repeatedReadDedup?: boolean;
  toolPayloadTrim?: boolean;
  htmlSlimming?: boolean;
  execOutputTruncation?: boolean;
  agentsStartupOptimization?: boolean;
};

export function isReductionPassEnabled(
  passId: string,
  passToggles?: ReductionPassToggles,
): boolean {
  if (!passToggles) return true;
  switch (passId) {
    case "repeated_read_dedup":
      return passToggles.repeatedReadDedup ?? true;
    case "tool_payload_trim":
      return passToggles.toolPayloadTrim ?? true;
    case "html_slimming":
      return passToggles.htmlSlimming ?? true;
    case "exec_output_truncation":
      return passToggles.execOutputTruncation ?? true;
    case "agents_startup_optimization":
      return passToggles.agentsStartupOptimization ?? true;
    default:
      return true;
  }
}
