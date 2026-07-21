import type {
  ProductSurfaceConfigAdapter,
  ProductCommandResult,
  ProductSurfaceHostBridge,
} from "@lightmem2/host-adapter";
import { diagnoseCacheAudit, summarizeCacheAudit, type CacheAuditRecord } from "@lightmem2/stabilizer";
import {
  buildSessionReportText,
  createProductSurfaceCommandHandler,
  formatDisplayValue,
  formatOnOff,
  getNestedValue,
  readRecentReductionMetrics,
  type ProductSurfaceLatestNonWarmCacheDiagnosis,
  type ProductSurfaceCacheAuditSummary,
  type ProductSurfaceLatestUxEffect,
  type ProductSurfaceSessionAggregate,
} from "@lightmem2/product-surface";
import { TOKENPILOT_PRODUCT_SURFACE_IDENTITY } from "@lightmem2/tokenpilot";

type LatestUxEffectWithSessionId = ProductSurfaceLatestUxEffect & {
  sessionId?: string | null;
};

function normalizeSessionId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

export function splitCommandArgs(raw: string): string[] {
  return raw.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

export function standardReductionModePreset(mode: "conservative" | "normal"): {
  triggerMinChars: number;
  maxToolChars: number;
} {
  if (mode === "conservative") {
    return {
      triggerMinChars: 4000,
      maxToolChars: 1800,
    };
  }
  return {
    triggerMinChars: 2200,
    maxToolChars: 1200,
  };
}

export function applyStandardRuntimeModeConfig(
  currentConfig: Record<string, unknown>,
  mode: "conservative" | "normal",
): Record<string, unknown> {
  const { triggerMinChars, maxToolChars } = standardReductionModePreset(mode);
  return {
    ...currentConfig,
    enabled: true,
    modules: {
      ...(typeof currentConfig.modules === "object" && currentConfig.modules
        ? currentConfig.modules as Record<string, unknown>
        : {}),
      stabilizer: true,
      reduction: true,
    },
    reduction: {
      ...(typeof currentConfig.reduction === "object" && currentConfig.reduction
        ? currentConfig.reduction as Record<string, unknown>
        : {}),
      triggerMinChars,
      maxToolChars,
    },
  };
}

export async function resolvePreferredSessionId(params: {
  explicitSessionId?: string;
  stateDir?: string;
  resolveLatestSessionId(stateDir: string): Promise<string | undefined>;
  readLatestUxEffect(stateDir: string): Promise<{ sessionId?: string | null } | null>;
}): Promise<string | undefined> {
  const explicitSessionId = normalizeSessionId(params.explicitSessionId);
  if (explicitSessionId) return explicitSessionId;
  const stateDir = normalizeSessionId(params.stateDir);
  if (!stateDir) return undefined;
  return normalizeSessionId(await params.resolveLatestSessionId(stateDir))
    ?? normalizeSessionId((await params.readLatestUxEffect(stateDir))?.sessionId);
}

export async function resolveConfiguredPreferredSessionId(params: {
  loadConfig(): Promise<Record<string, unknown>>;
  resolveStateDir(config: Record<string, unknown>): string | undefined;
  resolveLatestSessionId(stateDir: string): Promise<string | undefined>;
  readLatestUxEffect(stateDir: string): Promise<{ sessionId?: string | null } | null>;
}): Promise<string | undefined> {
  const currentConfig = await params.loadConfig();
  const stateDir = normalizeSessionId(params.resolveStateDir(currentConfig));
  if (!stateDir) return undefined;
  return resolvePreferredSessionId({
    stateDir,
    resolveLatestSessionId: params.resolveLatestSessionId,
    readLatestUxEffect: params.readLatestUxEffect,
  });
}

export async function buildSessionReportResult(params: {
  currentConfig: Record<string, unknown>;
  explicitSessionId?: string;
  configAdapter: ProductSurfaceConfigAdapter;
  resolveLatestSessionId(stateDir: string): Promise<string | undefined>;
  readLatestUxEffect(stateDir: string): Promise<LatestUxEffectWithSessionId | null>;
  readSessionAggregate(stateDir: string, sessionId: string): Promise<ProductSurfaceSessionAggregate | null>;
  readRecentCacheAuditRecords?(
    stateDir: string,
    sessionId: string,
  ): Promise<CacheAuditRecord[]>;
}): Promise<ProductCommandResult> {
  const stateDir = params.configAdapter.resolveStateDir(params.currentConfig);
  if (!stateDir) {
    return { text: "TokenPilot stateDir is not configured." };
  }
  const latest = await params.readLatestUxEffect(stateDir);
  const sessionId = await resolvePreferredSessionId({
    explicitSessionId: params.explicitSessionId,
    stateDir,
    resolveLatestSessionId: params.resolveLatestSessionId,
    readLatestUxEffect: params.readLatestUxEffect,
  });
  if (!sessionId) {
    return { text: "No TokenPilot session stats yet." };
  }
  const pluginCfg = params.configAdapter.pluginConfigRecord(params.currentConfig);
  const detailsEnabled = getNestedValue(pluginCfg, ["ux", "details"]) === true;
  const aggregate = await params.readSessionAggregate(stateDir, sessionId);
  const recentMetrics = detailsEnabled
    ? await readRecentReductionMetrics(stateDir, sessionId)
    : null;
  const cacheAuditRecords = detailsEnabled && params.readRecentCacheAuditRecords
    ? await params.readRecentCacheAuditRecords(stateDir, sessionId)
    : [];
  const cacheAuditSummary: ProductSurfaceCacheAuditSummary | null = cacheAuditRecords.length > 0
    ? summarizeCacheAudit(cacheAuditRecords)
    : null;
  const latestNonWarmCacheDiagnosis = selectLatestNonWarmCacheDiagnosisFromCacheAudit(cacheAuditRecords);
  if (!aggregate && !cacheAuditSummary) {
    return { text: `No TokenPilot savings recorded yet for session ${sessionId}.` };
  }
  return {
    text: buildSessionReportText({
      title: "TokenPilot report:",
      sessionId,
      aggregate,
      latest,
      detailsEnabled,
      recentMetrics,
      cacheAuditSummary,
      latestNonWarmCacheDiagnosis,
    }),
  };
}

export function selectLatestNonWarmCacheDiagnosisFromCacheAudit(
  records: CacheAuditRecord[],
): ProductSurfaceLatestNonWarmCacheDiagnosis | null {
  const ordered = [...records].sort((left, right) => String(right.at).localeCompare(String(left.at)));
  for (const record of ordered) {
    const diagnosis = diagnoseCacheAudit({
      stablePrefixFingerprint: record.stablePrefixFingerprint,
      requestPromptCacheKey: record.requestPromptCacheKey,
      responsePromptCacheKey: record.responsePromptCacheKey,
      cachedInputTokens: Number(record.cachedInputTokens ?? 0),
      baselineKind: record.baselineKind ?? "none",
      entropyFindings: Array.isArray(record.entropyFindings) ? record.entropyFindings : [],
      driftReasons: Array.isArray(record.driftReasons) ? record.driftReasons : [],
    });
    if (diagnosis.matchedResult === "warm hit" || diagnosis.matchedResult === "unmatched") continue;
    return {
      at: record.at,
      matchedResult: diagnosis.matchedResult,
      driftKeys: Array.isArray(record.driftReasons)
        ? record.driftReasons.map((entry) => String(entry.key || "")).filter(Boolean)
        : [],
      entropyKinds: Array.isArray(record.entropyFindings)
        ? record.entropyFindings.map((entry) => String(entry.kind || "")).filter(Boolean)
        : [],
      currentState: diagnosis.currentState,
      optimizationHint: diagnosis.optimizationHint,
    };
  }
  return null;
}

export function formatRestrictedHostHelp(params: {
  displayName: string;
  cliHostName: string;
  section?: string;
  reductionPassNames: readonly string[];
}): string {
  if (params.section === "stabilizer") {
    return [
      `Prefix Stabilization commands (${params.displayName}):`,
      `lightmem2 ${params.cliHostName} stabilizer`,
      `lightmem2 ${params.cliHostName} stabilizer on`,
      `lightmem2 ${params.cliHostName} stabilizer off`,
      `lightmem2 ${params.cliHostName} stabilizer target <developer|user>`,
      "",
      "Supported knobs:",
      "- modules.stabilizer",
      "- hooks.dynamicContextTarget",
    ].join("\n");
  }

  if (params.section === "reduction") {
    return [
      `Observation Reduction commands (${params.displayName}):`,
      `lightmem2 ${params.cliHostName} reduction`,
      `lightmem2 ${params.cliHostName} reduction on`,
      `lightmem2 ${params.cliHostName} reduction off`,
      `lightmem2 ${params.cliHostName} reduction mode <light|balanced|aggressive>`,
      `lightmem2 ${params.cliHostName} reduction pass <name> <on|off>`,
      `lightmem2 ${params.cliHostName} reduction set <triggerMinChars|maxToolChars> <number>`,
      "",
      "Supported pass names:",
      ...params.reductionPassNames.map((name) => `- ${name}`),
    ].join("\n");
  }

  return [
    `LightMem2 ${params.displayName} commands:`,
    "",
    `lightmem2 ${params.cliHostName} status`,
    `lightmem2 ${params.cliHostName} report`,
    `lightmem2 ${params.cliHostName} doctor`,
    `lightmem2 ${params.cliHostName} visual`,
    `lightmem2 ${params.cliHostName} mode <conservative|normal>`,
    `lightmem2 ${params.cliHostName} stabilizer ...`,
    `lightmem2 ${params.cliHostName} reduction ...`,
    "",
    `Not supported on ${params.displayName} yet:`,
    "- settings ...",
    "- eviction ...",
    "- mode aggressive",
    "- stabilizer hook ...",
  ].join("\n");
}

export function formatRestrictedHostStabilizerStatus(
  displayName: string,
  currentConfig: Record<string, unknown>,
): string {
  return [
    `Prefix Stabilization (${displayName}):`,
    `- enabled: ${formatOnOff(getNestedValue(currentConfig, ["modules", "stabilizer"]))}`,
    `- dynamicContextTarget: ${formatDisplayValue(getNestedValue(currentConfig, ["hooks", "dynamicContextTarget"]))}`,
  ].join("\n");
}

export function formatRestrictedHostReductionStatus(
  displayName: string,
  currentConfig: Record<string, unknown>,
  reductionPassNames: readonly string[],
): string {
  const passFlags = reductionPassNames
    .map((name) => `${name}=${formatOnOff(getNestedValue(currentConfig, ["reduction", "passes", name]))}`)
    .join(", ");
  return [
    `Observation Reduction (${displayName}):`,
    `- enabled: ${formatOnOff(getNestedValue(currentConfig, ["modules", "reduction"]))}`,
    `- triggerMinChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "triggerMinChars"]))}`,
    `- maxToolChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "maxToolChars"]))}`,
    `- passes: ${passFlags}`,
  ].join("\n");
}

export function createRestrictedHostCommandHandler(params: {
  displayName: string;
  cliHostName: string;
  reductionPassNames: readonly string[];
  bridge: ProductSurfaceHostBridge;
  configAdapter: ProductSurfaceConfigAdapter;
  loadConfig(): Promise<Record<string, unknown>>;
  formatStatus(currentConfig: Record<string, unknown>): string;
  applyMode(mode: "conservative" | "normal"): Promise<void>;
}): (ctx: { args: string; sessionId?: string }) => Promise<{ text: string }> {
  const sharedHandler = createProductSurfaceCommandHandler({
    bridge: params.bridge,
    configAdapter: params.configAdapter,
    identity: TOKENPILOT_PRODUCT_SURFACE_IDENTITY,
  });

  function isReductionPassName(value: string): boolean {
    return params.reductionPassNames.includes(value);
  }

  return async function handleCommand(ctx: {
    args: string;
    sessionId?: string;
  }): Promise<{ text: string }> {
    const args = splitCommandArgs(ctx.args);
    const action = args[0]?.toLowerCase() ?? "";

    if (!action) {
      return {
        text: `${params.formatStatus(await params.loadConfig())}\n\n${formatRestrictedHostHelp({
          displayName: params.displayName,
          cliHostName: params.cliHostName,
          reductionPassNames: params.reductionPassNames,
        })}`,
      };
    }

    if (action === "help") {
      return {
        text: formatRestrictedHostHelp({
          displayName: params.displayName,
          cliHostName: params.cliHostName,
          section: args[1]?.toLowerCase(),
          reductionPassNames: params.reductionPassNames,
        }),
      };
    }

    if (action === "status") {
      return { text: params.formatStatus(await params.loadConfig()) };
    }

    if (action === "report" || action === "doctor" || action === "visual") {
      return sharedHandler(ctx);
    }

    if (action === "reduction") {
      const sub = args[1]?.toLowerCase() ?? "";
      if (!sub || sub === "status" || sub === "show") {
        return {
          text: formatRestrictedHostReductionStatus(
            params.displayName,
            await params.loadConfig(),
            params.reductionPassNames,
          ),
        };
      }
      if (sub === "help") {
        return {
          text: formatRestrictedHostHelp({
            displayName: params.displayName,
            cliHostName: params.cliHostName,
            section: "reduction",
            reductionPassNames: params.reductionPassNames,
          }),
        };
      }
      if (sub === "pass") {
        const passName = args[2] ?? "";
        if (!isReductionPassName(passName)) {
          return {
            text: `${params.displayName} reduction supports only these passes: ${params.reductionPassNames.join(", ")}`,
          };
        }
      }
      return sharedHandler(ctx);
    }

    if (action === "stabilizer") {
      const sub = args[1]?.toLowerCase() ?? "";
      if (!sub || sub === "status" || sub === "show") {
        return {
          text: formatRestrictedHostStabilizerStatus(params.displayName, await params.loadConfig()),
        };
      }
      if (sub === "help") {
        return {
          text: formatRestrictedHostHelp({
            displayName: params.displayName,
            cliHostName: params.cliHostName,
            section: "stabilizer",
            reductionPassNames: params.reductionPassNames,
          }),
        };
      }
      if (sub === "on" || sub === "off" || sub === "target") {
        return sharedHandler(ctx);
      }
      return {
        text: `${params.displayName} currently supports only \`stabilizer on|off\` and \`stabilizer target <developer|user>\`.`,
      };
    }

    if (action === "mode") {
      const mode = args[1]?.toLowerCase() ?? "";
      if (mode === "conservative" || mode === "normal") {
        await params.applyMode(mode);
        return { text: `✅ Runtime mode = ${mode}` };
      }
      if (mode === "aggressive") {
        return {
          text: `${params.displayName} does not support lifecycle eviction mode. Use \`mode normal\` or \`mode conservative\`.`,
        };
      }
      return { text: `Usage: lightmem2 ${params.cliHostName} mode <conservative|normal>` };
    }

    if (action === "settings") {
      return { text: `${params.displayName} does not expose shared runtime settings yet.` };
    }

    if (action === "eviction") {
      return { text: `${params.displayName} lifecycle eviction controls are not supported.` };
    }

    return {
      text: `Unsupported ${params.displayName} command. Supported commands: status, report, doctor, visual, mode <conservative|normal>, reduction ..., stabilizer on|off|target.`,
    };
  };
}
