import type { ProductSurfaceConfigAdapter } from "@lightmem2/host-adapter";
import {
  TOKENPILOT_FEATURE_MODULE_IDS,
  type SessionModuleObservationSummary,
  type TokenPilotFeatureModuleId,
} from "./module-observability.js";
import { readRecentReductionMetrics, summarizeRecentReductionMetrics } from "./metrics.js";
import {
  RUNTIME_MODE_PRESETS,
  REDUCTION_PASS_PATHS,
  countModeDescription,
  countModeLabel,
  formatDisplayValue,
  formatInt,
  formatOnOff,
  getNestedValue,
} from "./config.js";

export type ProductSurfaceLatestUxEffect = {
  sessionId?: string;
  countMode?: "openai_tokens" | "chars";
  details?: {
    requestSavedCount?: number;
    responseSavedCount?: number;
  };
};

export type ProductSurfaceSessionAggregate = {
  turns: number;
  latestCountMode?: "openai_tokens" | "chars";
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
  recoveryObservedSegments: number;
  recoverySkippedSegments: number;
  skippedReasons: Record<string, number>;
};

export type ProductSurfaceSessionOverviewItem = {
  label: string;
  value: string | number;
};

export type ProductSurfaceLatestNonWarmCacheDiagnosis = {
  at?: string;
  matchedResult: "cold start" | "cold miss";
  driftKeys: string[];
  entropyKinds: string[];
  currentState: string;
  optimizationHint: string;
};

export type ProductSurfaceSessionReportData = {
  title?: string;
  sessionId: string;
  aggregate: ProductSurfaceSessionAggregate | null;
  latest?: ProductSurfaceLatestUxEffect | null;
  detailsEnabled: boolean;
  recentMetrics?: ProductSurfaceRecentReductionMetrics | null;
  overview?: ProductSurfaceSessionOverviewItem[];
  emptyMessage?: string;
  cacheAuditSummary?: {
    warmCandidates: number;
    warmHits: number;
    warmMisses: number;
    hitRatePercent: number;
    responsePromptCacheKeyRewriteCount?: number;
    promptCacheKeyMismatchCount: number;
    topEntropyKinds: Array<{ key: string; count: number }>;
    topDriftKeys: Array<{ key: string; count: number }>;
  } | null;
  latestNonWarmCacheDiagnosis?: ProductSurfaceLatestNonWarmCacheDiagnosis | null;
  moduleSummary?: SessionModuleObservationSummary | null;
};

export type ProductSurfaceCacheAuditSummary = NonNullable<ProductSurfaceSessionReportData["cacheAuditSummary"]>;

export type ProductSurfaceSessionReportReaders = {
  readLatest(
    stateDir: string,
  ): Promise<ProductSurfaceLatestUxEffect | null>;
  readAggregate(
    stateDir: string,
    sessionId: string,
  ): Promise<ProductSurfaceSessionAggregate | null>;
  readRecentMetrics?(
    stateDir: string,
    sessionId: string,
  ): Promise<ProductSurfaceRecentReductionMetrics | null>;
};

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  const rounded = Math.round(value * 10);
  return rounded % 10 === 0
    ? `${Math.round(value)}%`
    : `${(rounded / 10).toFixed(1)}%`;
}

function buildLatestNonWarmDiagnosisLines(
  latestNonWarmCacheDiagnosis?: ProductSurfaceLatestNonWarmCacheDiagnosis | null,
): string[] {
  if (!latestNonWarmCacheDiagnosis) return [];
  const drift = latestNonWarmCacheDiagnosis.driftKeys
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const entropy = latestNonWarmCacheDiagnosis.entropyKinds
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const diagnosisLabel = latestNonWarmCacheDiagnosis.matchedResult === "cold start"
    ? "latest cold start"
    : "latest cold miss";
  const lines: string[] = [];
  if (drift.length > 0) {
    lines.push(`- ${diagnosisLabel} drift: ${drift.join(", ")}`);
  } else if (entropy.length > 0) {
    lines.push(`- ${diagnosisLabel} entropy: ${entropy.join(", ")}`);
  }
  if (latestNonWarmCacheDiagnosis.optimizationHint) {
    lines.push(`- ${diagnosisLabel} hint: ${latestNonWarmCacheDiagnosis.optimizationHint}`);
  }
  return lines;
}

function formatModuleObservationLine(
  moduleId: TokenPilotFeatureModuleId,
  module: SessionModuleObservationSummary["modules"][TokenPilotFeatureModuleId],
): string {
  const cost = typeof module.apiCostUsd === "number"
    ? `, api cost=$${module.apiCostUsd.toFixed(6)}`
    : "";
  const enabled = module.observed === false ? "unknown" : String(module.enabled);
  const accounting = `estimated saved=${formatInt(module.savedTokens)} tokens/${formatInt(module.savedChars)} chars, estimator api=${formatInt(module.apiInputTokens)} input + ${formatInt(module.apiOutputTokens)} output tokens${cost}`;
  if (
    moduleId === "eviction"
    && module.executionsByPhase
    && module.phaseBreakdownComplete !== false
  ) {
    return `- eviction: enabled=${enabled}, planning runs=${formatInt(module.executionsByPhase.request)}, history runs=${formatInt(module.executionsByPhase.history)}, applications=${formatInt(module.changes)}, ${accounting}`;
  }
  return `- ${moduleId}: enabled=${enabled}, executions=${formatInt(module.executions)}, changes=${formatInt(module.changes)}, ${accounting}`;
}

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
  adapter: ProductSurfaceConfigAdapter,
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
  adapter: ProductSurfaceConfigAdapter,
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
  adapter: ProductSurfaceConfigAdapter,
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
  adapter: ProductSurfaceConfigAdapter,
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
  title?: string;
  sessionId: string;
  aggregate: ProductSurfaceSessionAggregate;
  latest?: ProductSurfaceLatestUxEffect | null;
  detailsEnabled: boolean;
  recentMetrics?: ProductSurfaceRecentReductionMetrics | null;
  overview?: ProductSurfaceSessionOverviewItem[];
  cacheAuditSummary?: ProductSurfaceSessionReportData["cacheAuditSummary"];
  latestNonWarmCacheDiagnosis?: ProductSurfaceSessionReportData["latestNonWarmCacheDiagnosis"];
  moduleSummary?: ProductSurfaceSessionReportData["moduleSummary"];
}): string {
  const {
    title,
    sessionId,
    aggregate,
    latest,
    detailsEnabled,
    recentMetrics,
    overview,
    cacheAuditSummary,
    latestNonWarmCacheDiagnosis,
    moduleSummary,
  } = params;
  const latestCountMode = latest?.countMode ?? aggregate.latestCountMode ?? "openai_tokens";
  const unitLabel = countModeLabel(latestCountMode);
  const savedCount = latestCountMode === "chars" ? aggregate.charSavedCount : aggregate.tokenSavedCount;
  const optimizedTurns = latestCountMode === "chars" ? aggregate.charOptimizedTurns : aggregate.tokenOptimizedTurns;
  const avgSavedPerOptimizedTurn = latestCountMode === "chars"
    ? aggregate.avgSavedCharsPerOptimizedTurn
    : aggregate.avgSavedTokensPerOptimizedTurn;
  const lines = [
    ...(overview ?? []).map((item) => `${item.label}: ${item.value}`),
    title ?? "TokenPilot report:",
    `- session: ${sessionId}`,
    ...(moduleSummary ? [`- module mode: ${moduleSummary.mode}`] : []),
    `- count mode: ${countModeDescription(latestCountMode)}`,
    `- saved ${unitLabel}: ${formatInt(savedCount)}`,
    `- recorded turns: ${formatInt(aggregate.turns)}`,
    `- optimized turns: ${formatInt(optimizedTurns)}`,
    `- avg saved ${unitLabel} per optimized turn: ${formatInt(avgSavedPerOptimizedTurn)}`,
  ];

  if (detailsEnabled) {
    if (moduleSummary) {
      for (const moduleId of TOKENPILOT_FEATURE_MODULE_IDS) {
        const module = moduleSummary.modules[moduleId];
        lines.push(formatModuleObservationLine(moduleId, module));
      }
    }
    if (latest?.details?.requestSavedCount !== undefined) {
      lines.push(`- latest request savings: ${formatInt(latest.details.requestSavedCount)} ${unitLabel}`);
    }
    if (latest?.details?.responseSavedCount !== undefined) {
      lines.push(`- latest response savings: ${formatInt(latest.details.responseSavedCount)} ${unitLabel}`);
    }
    if (recentMetrics) {
      const summary = summarizeRecentReductionMetrics(recentMetrics);
      const topRoutes = summary.topRoutes
        .map((entry) => `${entry.key}=${formatInt(entry.value)} ${unitLabel}/${formatInt(entry.hits ?? 0)} hits`)
        .join(", ");
      const topPasses = summary.topPasses
        .map((entry) => `${entry.key}=${formatInt(entry.value)} ${unitLabel}`)
        .join(", ");
      const skippedReasons = summary.topSkippedReasons
        .map((entry) => `${entry.key}=${formatInt(entry.value)}`)
        .join(", ");
      lines.push(`- recent sampled turns: ${formatInt(recentMetrics.sampledTurns)}`);
      if (summary.totalSavedChars > 0) {
        lines.push(`- recent total savings: ${formatInt(summary.totalSavedChars)} ${unitLabel}`);
      }
      if (summary.dominantRoute) {
        lines.push(
          `- recent dominant route: ${summary.dominantRoute.key}=${formatInt(summary.dominantRoute.value)} ${unitLabel} (${formatPercent(summary.dominantRoute.sharePercent ?? 0)}, ${formatInt(summary.dominantRoute.hits ?? 0)} hits)`,
        );
      }
      if (summary.mostTrimmedRoute) {
        lines.push(`- recent most-trimmed route: ${summary.mostTrimmedRoute.key}=${formatInt(summary.mostTrimmedRoute.value)} hits`);
      }
      if (summary.dominantPass) {
        lines.push(`- recent dominant pass: ${summary.dominantPass.key}=${formatInt(summary.dominantPass.value)} ${unitLabel}`);
      }
      if (topRoutes) lines.push(`- recent top routes: ${topRoutes}`);
      if (topPasses) lines.push(`- recent top passes: ${topPasses}`);
      if (recentMetrics.recoveryObservedSegments > 0 || recentMetrics.recoverySkippedSegments > 0) {
        lines.push(
          `- recent recovery segments: observed=${formatInt(recentMetrics.recoveryObservedSegments)}, exempted=${formatInt(recentMetrics.recoverySkippedSegments)}`,
        );
      }
      if (skippedReasons) lines.push(`- recent skipped reasons: ${skippedReasons}`);
    }
    if (cacheAuditSummary && cacheAuditSummary.warmCandidates > 0) {
      lines.push(`- cache warm hits: ${formatInt(cacheAuditSummary.warmHits)}/${formatInt(cacheAuditSummary.warmCandidates)} (${formatPercent(cacheAuditSummary.hitRatePercent)})`);
      if (cacheAuditSummary.warmMisses > 0) {
        lines.push(`- cache warm misses: ${formatInt(cacheAuditSummary.warmMisses)}`);
      }
    }
    const responseKeyRewriteCount =
      cacheAuditSummary?.responsePromptCacheKeyRewriteCount
      ?? cacheAuditSummary?.promptCacheKeyMismatchCount
      ?? 0;
    if (responseKeyRewriteCount > 0) {
      lines.push(`- response cache key rewrites: ${formatInt(responseKeyRewriteCount)}`);
    }
    if (cacheAuditSummary?.topEntropyKinds?.length) {
      lines.push(
        `- cache entropy hotspots: ${cacheAuditSummary.topEntropyKinds
          .map((entry) => `${entry.key}=${formatInt(entry.count)}`)
          .join(", ")}`,
      );
    }
    if (cacheAuditSummary?.topDriftKeys?.length) {
      lines.push(
        `- cache drift hotspots: ${cacheAuditSummary.topDriftKeys
          .map((entry) => `${entry.key}=${formatInt(entry.count)}`)
          .join(", ")}`,
      );
    }
    lines.push(...buildLatestNonWarmDiagnosisLines(latestNonWarmCacheDiagnosis));
  }

  return lines.join("\n");
}

export function buildSessionReportText(params: ProductSurfaceSessionReportData): string {
  const {
    title,
    sessionId,
    aggregate,
    latest,
    detailsEnabled,
    recentMetrics,
    overview,
    emptyMessage,
    cacheAuditSummary,
    latestNonWarmCacheDiagnosis,
    moduleSummary,
  } = params;

  if (!aggregate) {
    const lines = [
      ...(overview ?? []).map((item) => `${item.label}: ${item.value}`),
      title ?? "TokenPilot report:",
      `- session: ${sessionId}`,
      ...(moduleSummary ? [`- module mode: ${moduleSummary.mode}`] : []),
      emptyMessage ?? "- no savings recorded yet",
    ];
    if (detailsEnabled) {
      if (moduleSummary) {
        for (const moduleId of TOKENPILOT_FEATURE_MODULE_IDS) {
          const module = moduleSummary.modules[moduleId];
          lines.push(formatModuleObservationLine(moduleId, module));
        }
      }
      if (cacheAuditSummary && cacheAuditSummary.warmCandidates > 0) {
        lines.push(`- cache warm hits: ${formatInt(cacheAuditSummary.warmHits)}/${formatInt(cacheAuditSummary.warmCandidates)} (${formatPercent(cacheAuditSummary.hitRatePercent)})`);
      }
      lines.push(...buildLatestNonWarmDiagnosisLines(latestNonWarmCacheDiagnosis));
    }
    return lines.join("\n");
  }

  return formatSessionReport({
    title,
    sessionId,
    aggregate,
    latest,
    detailsEnabled,
    recentMetrics,
    overview,
    cacheAuditSummary,
    latestNonWarmCacheDiagnosis,
    moduleSummary,
  });
}

export async function loadSessionReportData(params: {
  stateDir: string;
  title?: string;
  sessionId: string;
  detailsEnabled: boolean;
  readers: ProductSurfaceSessionReportReaders;
  recentMetrics?: ProductSurfaceRecentReductionMetrics | null;
  overview?: ProductSurfaceSessionOverviewItem[];
  emptyMessage?: string;
  cacheAuditSummary?: ProductSurfaceSessionReportData["cacheAuditSummary"];
  latestNonWarmCacheDiagnosis?: ProductSurfaceSessionReportData["latestNonWarmCacheDiagnosis"];
  moduleSummary?: ProductSurfaceSessionReportData["moduleSummary"];
}): Promise<ProductSurfaceSessionReportData> {
  const {
    stateDir,
    title,
    sessionId,
    detailsEnabled,
    readers,
    recentMetrics,
    overview,
    emptyMessage,
    cacheAuditSummary,
    latestNonWarmCacheDiagnosis,
    moduleSummary,
  } = params;
  const [aggregate, latest, loadedRecentMetrics] = await Promise.all([
    readers.readAggregate(stateDir, sessionId),
    readers.readLatest(stateDir),
    detailsEnabled && !recentMetrics
      ? (readers.readRecentMetrics
        ? readers.readRecentMetrics(stateDir, sessionId)
        : readRecentReductionMetrics(stateDir, sessionId))
      : Promise.resolve(null),
  ]);

  return {
    title,
    sessionId,
    aggregate,
    latest: latest?.sessionId === sessionId ? latest : null,
    detailsEnabled,
    recentMetrics: recentMetrics ?? loadedRecentMetrics,
    overview,
    emptyMessage,
    cacheAuditSummary,
    latestNonWarmCacheDiagnosis,
    moduleSummary,
  };
}

export async function renderSessionReport(params: {
  stateDir: string;
  title?: string;
  sessionId: string;
  detailsEnabled: boolean;
  readers: ProductSurfaceSessionReportReaders;
  recentMetrics?: ProductSurfaceRecentReductionMetrics | null;
  overview?: ProductSurfaceSessionOverviewItem[];
  emptyMessage?: string;
  cacheAuditSummary?: ProductSurfaceSessionReportData["cacheAuditSummary"];
  latestNonWarmCacheDiagnosis?: ProductSurfaceSessionReportData["latestNonWarmCacheDiagnosis"];
  moduleSummary?: ProductSurfaceSessionReportData["moduleSummary"];
}): Promise<string> {
  return buildSessionReportText(await loadSessionReportData(params));
}

export { formatInt };
