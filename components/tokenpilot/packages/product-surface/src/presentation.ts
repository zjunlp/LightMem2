import type { TokenPilotProductSurfaceConfigAdapter } from "@tokenpilot/host-adapter";
import {
  RUNTIME_MODE_PRESETS,
  REDUCTION_PASS_PATHS,
  countModeLabel,
  formatDisplayValue,
  formatInt,
  formatOnOff,
  getNestedValue,
} from "./config.js";

export type ProductSurfaceLatestUxEffect = {
  countMode?: "litellm_tokens" | "chars";
  details?: {
    requestSavedCount?: number;
    responseSavedCount?: number;
  };
};

export type ProductSurfaceSessionAggregate = {
  turns: number;
  latestCountMode?: "litellm_tokens" | "chars";
  tokenOptimizedTurns: number;
  tokenSavedCount: number;
  avgSavedTokensPerOptimizedTurn: number;
  charOptimizedTurns: number;
  charSavedCount: number;
  avgSavedCharsPerOptimizedTurn: number;
};

export type ProductSurfaceRecentReductionMetrics = {
  sampledTurns: number;
  routeSavedChars: Record<string, number>;
  routeHitCount: Record<string, number>;
  passSavedChars: Record<string, number>;
};

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
      "- readStateCompaction",
      "- toolPayloadTrim",
      "- htmlSlimming",
      "- execOutputTruncation",
      "- agentsStartupOptimization",
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
    "/tokenpilot doctor",
    "/tokenpilot help [stabilizer|reduction|eviction]",
    "/tokenpilot report",
    "/tokenpilot visual",
    "/tokenpilot mode <conservative|normal|aggressive>",
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
    "/tokenpilot doctor",
    "/tokenpilot visual",
    "/tokenpilot mode normal",
    "/tokenpilot settings details on",
    "/tokenpilot reduction mode balanced",
    "/tokenpilot reduction pass toolPayloadTrim off",
    "/tokenpilot eviction on",
    "/tokenpilot eviction set minBlockChars 512",
    "/tokenpilot stabilizer target developer",
  ].join("\n");
}

export function summarizeTokenPilotStatus(
  cfg: Record<string, unknown>,
  adapter: TokenPilotProductSurfaceConfigAdapter,
): string {
  const entry = adapter.pluginEntryRecord(cfg);
  const pluginCfg = adapter.pluginConfigRecord(cfg);
  const stabilizerEnabled = getNestedValue(pluginCfg, ["modules", "stabilizer"]);
  const reductionEnabled = getNestedValue(pluginCfg, ["modules", "reduction"]);
  const evictionEnabled = Boolean(getNestedValue(pluginCfg, ["modules", "eviction"])) && Boolean(getNestedValue(pluginCfg, ["eviction", "enabled"]));
  const estimatorEnabled = getNestedValue(pluginCfg, ["taskStateEstimator", "enabled"]);
  const triggerMinChars = getNestedValue(pluginCfg, ["reduction", "triggerMinChars"]);
  const maxToolChars = getNestedValue(pluginCfg, ["reduction", "maxToolChars"]);
  const modeLabel = Object.entries(RUNTIME_MODE_PRESETS).find(([, preset]) => {
    const reductionPreset =
      preset.reductionPreset === "light"
        ? [4000, 1800]
        : preset.reductionPreset === "balanced"
          ? [2200, 1200]
          : [1400, 900];
    return (
      stabilizerEnabled === true
      && reductionEnabled === true
      && evictionEnabled === preset.evictionEnabled
      && estimatorEnabled === preset.taskStateEstimatorEnabled
      && triggerMinChars === reductionPreset[0]
      && maxToolChars === reductionPreset[1]
    );
  })?.[0] ?? "custom";

  return [
    "TokenPilot status:",
    `- entry.enabled: ${formatOnOff(entry?.enabled)}`,
    `- config.enabled: ${formatOnOff(pluginCfg?.enabled)}`,
    `- mode: ${modeLabel}`,
    `- stabilizer: ${formatOnOff(stabilizerEnabled)}`,
    `- reduction: ${formatOnOff(reductionEnabled)}`,
    `- lifecycle eviction: ${formatOnOff(evictionEnabled)}`,
    `- task-state estimator: ${formatOnOff(estimatorEnabled)}`,
    `- details: ${formatOnOff(getNestedValue(pluginCfg, ["ux", "details"]))}`,
    `- proxyAutostart: ${formatOnOff(pluginCfg?.proxyAutostart)}`,
    `- proxyPort: ${formatDisplayValue(pluginCfg?.proxyPort)}`,
  ].join("\n");
}

export function summarizeStabilizerStatus(
  cfg: Record<string, unknown>,
  adapter: TokenPilotProductSurfaceConfigAdapter,
): string {
  const pluginCfg = adapter.pluginConfigRecord(cfg);
  return [
    "Prefix Stabilization:",
    `- enabled: ${formatOnOff(getNestedValue(pluginCfg, ["modules", "stabilizer"]))}`,
    `- beforeToolCall: ${formatOnOff(getNestedValue(pluginCfg, ["hooks", "beforeToolCall"]))}`,
    `- dynamicContextTarget: ${formatDisplayValue(getNestedValue(pluginCfg, ["hooks", "dynamicContextTarget"]))}`,
  ].join("\n");
}

export function summarizeReductionStatus(
  cfg: Record<string, unknown>,
  adapter: TokenPilotProductSurfaceConfigAdapter,
): string {
  const pluginCfg = adapter.pluginConfigRecord(cfg);
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

export function summarizeEvictionStatus(
  cfg: Record<string, unknown>,
  adapter: TokenPilotProductSurfaceConfigAdapter,
): string {
  const pluginCfg = adapter.pluginConfigRecord(cfg);
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

export function formatSessionReport(params: {
  sessionId: string;
  aggregate: ProductSurfaceSessionAggregate;
  latest?: ProductSurfaceLatestUxEffect | null;
  detailsEnabled: boolean;
  recentMetrics?: ProductSurfaceRecentReductionMetrics | null;
}): string {
  const { sessionId, aggregate, latest, detailsEnabled, recentMetrics } = params;
  const latestCountMode = latest?.countMode ?? aggregate.latestCountMode ?? "litellm_tokens";
  const unitLabel = countModeLabel(latestCountMode);
  const savedCount = latestCountMode === "chars" ? aggregate.charSavedCount : aggregate.tokenSavedCount;
  const optimizedTurns = latestCountMode === "chars" ? aggregate.charOptimizedTurns : aggregate.tokenOptimizedTurns;
  const avgSavedPerOptimizedTurn = latestCountMode === "chars"
    ? aggregate.avgSavedCharsPerOptimizedTurn
    : aggregate.avgSavedTokensPerOptimizedTurn;
  const lines = [
    "TokenPilot report:",
    `- session: ${sessionId}`,
    `- saved ${unitLabel}: ${formatInt(savedCount)}`,
    `- recorded turns: ${formatInt(aggregate.turns)}`,
    `- optimized turns: ${formatInt(optimizedTurns)}`,
    `- avg saved ${unitLabel} per optimized turn: ${formatInt(avgSavedPerOptimizedTurn)}`,
  ];

  if (detailsEnabled) {
    if (latest?.details?.requestSavedCount !== undefined) {
      lines.push(`- latest request savings: ${formatInt(latest.details.requestSavedCount)} ${unitLabel}`);
    }
    if (latest?.details?.responseSavedCount !== undefined) {
      lines.push(`- latest response savings: ${formatInt(latest.details.responseSavedCount)} ${unitLabel}`);
    }
    if (recentMetrics) {
      const topRoutes = Object.entries(recentMetrics.routeSavedChars)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([route, saved]) => `${route}=${formatInt(saved)} ${unitLabel}/${formatInt(recentMetrics.routeHitCount[route] ?? 0)} hits`)
        .join(", ");
      const topPasses = Object.entries(recentMetrics.passSavedChars)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([pass, saved]) => `${pass}=${formatInt(saved)} ${unitLabel}`)
        .join(", ");
      lines.push(`- recent sampled turns: ${formatInt(recentMetrics.sampledTurns)}`);
      if (topRoutes) lines.push(`- recent top routes: ${topRoutes}`);
      if (topPasses) lines.push(`- recent top passes: ${topPasses}`);
    }
  }

  return lines.join("\n");
}

export { formatInt };
