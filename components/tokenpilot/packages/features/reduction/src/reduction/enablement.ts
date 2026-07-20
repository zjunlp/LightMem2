export type ReductionPassToggles = {
  readStateCompaction?: boolean;
  toolPayloadTrim?: boolean;
  htmlSlimming?: boolean;
  execOutputTruncation?: boolean;
  agentsStartupOptimization?: boolean;
  formatSlimming?: boolean;
  formatCleaning?: boolean;
  pathTruncation?: boolean;
  imageDownsample?: boolean;
  lineNumberStrip?: boolean;
};

export function isReductionPassEnabled(
  passId: string,
  passToggles?: ReductionPassToggles,
): boolean {
  if (!passToggles) return true;
  switch (passId) {
    case "read_state_compaction":
      return passToggles.readStateCompaction ?? true;
    case "tool_payload_trim":
      return passToggles.toolPayloadTrim ?? true;
    case "html_slimming":
      return passToggles.htmlSlimming ?? true;
    case "exec_output_truncation":
      return passToggles.execOutputTruncation ?? true;
    case "agents_startup_optimization":
      return passToggles.agentsStartupOptimization ?? true;
    case "format_slimming":
      return passToggles.formatSlimming ?? true;
    case "format_cleaning":
      return passToggles.formatCleaning ?? true;
    case "path_truncation":
      return passToggles.pathTruncation ?? true;
    case "image_downsample":
      return passToggles.imageDownsample ?? true;
    case "line_number_strip":
      return passToggles.lineNumberStrip ?? true;
    default:
      return true;
  }
}
