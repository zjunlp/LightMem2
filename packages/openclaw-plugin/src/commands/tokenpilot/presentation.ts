import {
  REDUCTION_PASS_PATHS,
  countModeLabel,
  formatDisplayValue,
  formatInt,
  formatOnOff,
  getNestedValue,
  pluginConfigRecord,
  pluginEntryRecord,
} from "./shared.js";

export function formatTokenPilotHelp(section?: string): string {
  if (section === "stabilizer") {
    return [
      "Prefix Stabilization commands:",
      "/tokenpilot stabilizer",
      "/tokenpilot stabilizer on",
      "/tokenpilot stabilizer off",
      "/tokenpilot stabilizer hook <on|off>",
      "/tokenpilot stabilizer target <developer|user>",
      "",
      "Knobs:",
      "- modules.stabilizer",
      "- hooks.beforeToolCall",
      "- hooks.dynamicContextTarget",
    ].join("\n");
  }

  if (section === "reduction") {
    return [
      "Observation Reduction commands:",
      "/tokenpilot reduction",
      "/tokenpilot reduction on",
      "/tokenpilot reduction off",
      "/tokenpilot reduction mode <light|balanced|aggressive>",
      "/tokenpilot reduction pass <name> <on|off>",
      "/tokenpilot reduction set <triggerMinChars|maxToolChars> <number>",
      "",
      "Pass names:",
      "- repeatedReadDedup",
      "- toolPayloadTrim",
      "- htmlSlimming",
      "- execOutputTruncation",
      "- agentsStartupOptimization",
      "- memoryFaultRecovery",
      "- formatSlimming",
      "- formatCleaning",
      "- pathTruncation",
      "- imageDownsample",
      "- lineNumberStrip",
    ].join("\n");
  }

  if (section === "eviction") {
    return [
      "Lifecycle-Aware Eviction commands:",
      "/tokenpilot eviction",
      "/tokenpilot eviction on",
      "/tokenpilot eviction off",
      "/tokenpilot eviction estimator <on|off>",
      "/tokenpilot eviction set <key> <value>",
      "",
      "Keys:",
      "- policy: noop|lru|lfu|gdsf|model_scored",
      "- minBlockChars",
      "- maxCandidateBlocks",
      "- replacementMode: pointer_stub|drop",
      "- batchTurns",
      "- evictionLookaheadTurns",
      "- completedSummaryMaxRawTurns",
      "- inputMode: sliding_window|completed_summary_plus_active_turns",
      "- lifecycleMode: coupled|decoupled",
      "- evidenceMode: three_state|two_state",
      "- evictionPromotionHotTailSize",
    ].join("\n");
  }

  return [
    "TokenPilot commands:",
    "",
    "/tokenpilot status",
    "/tokenpilot help [stabilizer|reduction|eviction]",
    "/tokenpilot report",
    "/tokenpilot settings details <on|off>",
    "/tokenpilot stabilizer ...",
    "/tokenpilot reduction ...",
    "/tokenpilot eviction ...",
    "",
    "Core modules:",
    "- Prefix Stabilization: prompt stability and dynamic context target",
    "- Observation Reduction: reduction presets, pass toggles, and thresholds",
    "- Lifecycle-Aware Eviction: eviction policy and task-state lifecycle knobs",
    "",
    "Examples:",
    "/tokenpilot report",
    "/tokenpilot settings details on",
    "/tokenpilot reduction mode balanced",
    "/tokenpilot reduction pass toolPayloadTrim off",
    "/tokenpilot eviction on",
    "/tokenpilot eviction set minBlockChars 512",
    "/tokenpilot stabilizer target developer",
  ].join("\n");
}

export function summarizeTokenPilotStatus(cfg: Record<string, unknown>): string {
  const entry = pluginEntryRecord(cfg);
  const pluginCfg = pluginConfigRecord(cfg);
  const stabilizerEnabled = getNestedValue(pluginCfg, ["modules", "stabilizer"]);
  const reductionEnabled = getNestedValue(pluginCfg, ["modules", "reduction"]);
  const evictionEnabled = Boolean(getNestedValue(pluginCfg, ["modules", "eviction"])) && Boolean(getNestedValue(pluginCfg, ["eviction", "enabled"]));
  const estimatorEnabled = getNestedValue(pluginCfg, ["taskStateEstimator", "enabled"]);

  return [
    "TokenPilot status:",
    `- entry.enabled: ${formatOnOff(entry?.enabled)}`,
    `- config.enabled: ${formatOnOff(pluginCfg?.enabled)}`,
    `- stabilizer: ${formatOnOff(stabilizerEnabled)}`,
    `- reduction: ${formatOnOff(reductionEnabled)}`,
    `- lifecycle eviction: ${formatOnOff(evictionEnabled)}`,
    `- task-state estimator: ${formatOnOff(estimatorEnabled)}`,
    `- details: ${formatOnOff(getNestedValue(pluginCfg, ["ux", "details"]))}`,
    `- proxyAutostart: ${formatOnOff(pluginCfg?.proxyAutostart)}`,
    `- proxyPort: ${formatDisplayValue(pluginCfg?.proxyPort)}`,
  ].join("\n");
}

export function summarizeStabilizerStatus(cfg: Record<string, unknown>): string {
  const pluginCfg = pluginConfigRecord(cfg);
  return [
    "Prefix Stabilization:",
    `- enabled: ${formatOnOff(getNestedValue(pluginCfg, ["modules", "stabilizer"]))}`,
    `- beforeToolCall: ${formatOnOff(getNestedValue(pluginCfg, ["hooks", "beforeToolCall"]))}`,
    `- dynamicContextTarget: ${formatDisplayValue(getNestedValue(pluginCfg, ["hooks", "dynamicContextTarget"]))}`,
  ].join("\n");
}

export function summarizeReductionStatus(cfg: Record<string, unknown>): string {
  const pluginCfg = pluginConfigRecord(cfg);
  const passSummary = Object.keys(REDUCTION_PASS_PATHS)
    .map((passName) => `${passName}=${formatOnOff(getNestedValue(pluginCfg, REDUCTION_PASS_PATHS[passName]))}`)
    .join(", ");

  return [
    "Observation Reduction:",
    `- enabled: ${formatOnOff(getNestedValue(pluginCfg, ["modules", "reduction"]))}`,
    `- engine: ${formatDisplayValue(getNestedValue(pluginCfg, ["reduction", "engine"]))}`,
    `- triggerMinChars: ${formatDisplayValue(getNestedValue(pluginCfg, ["reduction", "triggerMinChars"]))}`,
    `- maxToolChars: ${formatDisplayValue(getNestedValue(pluginCfg, ["reduction", "maxToolChars"]))}`,
    `- passes: ${passSummary}`,
  ].join("\n");
}

export function summarizeEvictionStatus(cfg: Record<string, unknown>): string {
  const pluginCfg = pluginConfigRecord(cfg);
  return [
    "Lifecycle-Aware Eviction:",
    `- moduleEnabled: ${formatOnOff(getNestedValue(pluginCfg, ["modules", "eviction"]))}`,
    `- evictionEnabled: ${formatOnOff(getNestedValue(pluginCfg, ["eviction", "enabled"]))}`,
    `- taskStateEstimator: ${formatOnOff(getNestedValue(pluginCfg, ["taskStateEstimator", "enabled"]))}`,
    `- policy: ${formatDisplayValue(getNestedValue(pluginCfg, ["eviction", "policy"]))}`,
    `- minBlockChars: ${formatDisplayValue(getNestedValue(pluginCfg, ["eviction", "minBlockChars"]))}`,
    `- maxCandidateBlocks: ${formatDisplayValue(getNestedValue(pluginCfg, ["eviction", "maxCandidateBlocks"]))}`,
    `- replacementMode: ${formatDisplayValue(getNestedValue(pluginCfg, ["eviction", "replacementMode"]))}`,
    `- batchTurns: ${formatDisplayValue(getNestedValue(pluginCfg, ["taskStateEstimator", "batchTurns"]))}`,
    `- evictionLookaheadTurns: ${formatDisplayValue(getNestedValue(pluginCfg, ["taskStateEstimator", "evictionLookaheadTurns"]))}`,
    `- lifecycleMode: ${formatDisplayValue(getNestedValue(pluginCfg, ["taskStateEstimator", "lifecycleMode"]))}`,
    `- evidenceMode: ${formatDisplayValue(getNestedValue(pluginCfg, ["taskStateEstimator", "evidenceMode"]))}`,
  ].join("\n");
}

export { formatInt };
