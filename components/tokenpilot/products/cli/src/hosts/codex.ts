import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  TokenPilotProductSurfaceConfigAdapter,
  TokenPilotProductSurfaceHostBridge,
  readLatestUxEffect,
  readUxSessionAggregate,
} from "@tokenpilot/host-adapter";
import {
  getNestedValue,
  formatDisplayValue,
  formatOnOff,
} from "@tokenpilot/product-surface";
import {
  defaultCodexConfigPath,
  defaultHooksConfigPath,
  defaultTokenPilotConfigPath,
  loadTokenPilotCodexConfig,
  normalizeTokenPilotCodexConfig,
  writeTokenPilotCodexConfig,
} from "../../../../adapters/codex/src/config.js";
import { inspectCodexDoctor, formatCodexDoctorReport } from "../../../../adapters/codex/src/doctor.js";
import {
  codexProductSurfaceConfigAdapter,
  resolveCodexStateDir,
} from "../../../../adapters/codex/src/host-config-adapter.js";
import {
  resolveCanonicalCodexSessionId,
  resolveLatestCodexSessionId,
} from "../../../../adapters/codex/src/session-state.js";
import { renderCodexSessionVisual } from "../../../../adapters/codex/src/session-visual.js";
import {
  applyStandardRuntimeModeConfig,
  buildSessionReportResult,
  createRestrictedHostCommandHandler,
  resolveConfiguredPreferredSessionId,
  resolvePreferredSessionId,
} from "./shared.js";

const CODEX_REDUCTION_PASS_NAMES = [
  "readStateCompaction",
  "toolPayloadTrim",
  "htmlSlimming",
  "execOutputTruncation",
  "agentsStartupOptimization",
] as const;

async function loadConfig(): Promise<Record<string, unknown>> {
  return loadTokenPilotCodexConfig(defaultTokenPilotConfigPath()) as unknown as Record<string, unknown>;
}

async function writeConfig(nextConfig: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(defaultTokenPilotConfigPath()), { recursive: true });
  await writeTokenPilotCodexConfig(
    normalizeTokenPilotCodexConfig(nextConfig),
    defaultTokenPilotConfigPath(),
  );
}

async function maybeResolveLatestSessionId(): Promise<string | undefined> {
  return resolveConfiguredPreferredSessionId({
    loadConfig,
    resolveStateDir: resolveCodexStateDir,
    resolveLatestSessionId: resolveLatestCodexSessionId,
    readLatestUxEffect,
  });
}

async function resolveCodexCliSessionId(params: {
  currentConfig: Record<string, unknown>;
  explicitSessionId?: string;
}): Promise<string | undefined> {
  const stateDir = resolveCodexStateDir(params.currentConfig);
  if (!stateDir) return undefined;
  const explicit = typeof params.explicitSessionId === "string" ? params.explicitSessionId.trim() : "";
  if (explicit) {
    return resolveCanonicalCodexSessionId(stateDir, explicit);
  }
  return resolvePreferredSessionId({
    stateDir,
    resolveLatestSessionId: resolveLatestCodexSessionId,
    readLatestUxEffect,
  });
}

function formatCodexStatus(currentConfig: Record<string, unknown>): string {
  return [
    "TokenPilot Codex status:",
    `- enabled: ${formatOnOff(currentConfig.enabled)}`,
    `- stabilizer: ${formatOnOff(getNestedValue(currentConfig, ["modules", "stabilizer"]))}`,
    `- dynamicContextTarget: ${formatDisplayValue(getNestedValue(currentConfig, ["hooks", "dynamicContextTarget"]))}`,
    `- reduction: ${formatOnOff(getNestedValue(currentConfig, ["modules", "reduction"]))}`,
    `- triggerMinChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "triggerMinChars"]))}`,
    `- maxToolChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "maxToolChars"]))}`,
    `- proxyPort: ${formatDisplayValue(currentConfig.proxyPort)}`,
    `- upstreamProvider: ${formatDisplayValue(currentConfig.upstreamProvider)}`,
  ].join("\n");
}

async function applyCodexMode(mode: "conservative" | "normal"): Promise<void> {
  const current = await loadConfig();
  await writeConfig(applyStandardRuntimeModeConfig(current, mode));
}

export function createCodexCliBridge(target: {
  host: "codex";
  sessionId?: string;
}): {
  bridge: TokenPilotProductSurfaceHostBridge;
  configAdapter: TokenPilotProductSurfaceConfigAdapter;
  maybeResolveLatestSessionId(): Promise<string | undefined>;
  resolveSessionId(sessionId?: string): Promise<string | undefined>;
  handleCommand(ctx: { args: string; sessionId?: string }): Promise<{ text: string }>;
} {
  const bridge: TokenPilotProductSurfaceHostBridge = {
    loadConfig,
    writeConfig,
    async handleDoctor(currentConfig) {
      const config = currentConfig as any;
      const report = await inspectCodexDoctor({
        config,
        configPath: defaultCodexConfigPath(),
        tokenPilotConfigPath: defaultTokenPilotConfigPath(),
        hooksConfigPath: defaultHooksConfigPath(),
      });
      return {
        text: formatCodexDoctorReport(report),
      };
    },
    async handleVisual(currentConfig) {
      const stateDir = resolveCodexStateDir(currentConfig);
      if (!stateDir) {
        return { text: "TokenPilot stateDir is not configured." };
      }
      const sessionId = await resolveCodexCliSessionId({
        currentConfig,
        explicitSessionId: target.sessionId,
      });
      return {
        text: await renderCodexSessionVisual(stateDir, sessionId),
      };
    },
    async handleReport(_ctx, currentConfig) {
      const sessionId = await resolveCodexCliSessionId({
        currentConfig,
        explicitSessionId: target.sessionId,
      });
      return buildSessionReportResult({
        currentConfig,
        explicitSessionId: sessionId,
        configAdapter: codexProductSurfaceConfigAdapter,
        resolveLatestSessionId: resolveLatestCodexSessionId,
        readLatestUxEffect,
        readSessionAggregate: readUxSessionAggregate,
      });
    },
  };

  const handleCommand = createRestrictedHostCommandHandler({
    displayName: "Codex",
    cliHostName: "codex",
    reductionPassNames: CODEX_REDUCTION_PASS_NAMES,
    bridge,
    configAdapter: codexProductSurfaceConfigAdapter,
    loadConfig,
    formatStatus: formatCodexStatus,
    applyMode: applyCodexMode,
  });

  return {
    bridge,
    configAdapter: codexProductSurfaceConfigAdapter,
    maybeResolveLatestSessionId,
    async resolveSessionId(sessionId?: string): Promise<string | undefined> {
      return resolveCodexCliSessionId({
        currentConfig: await loadConfig(),
        explicitSessionId: sessionId,
      });
    },
    handleCommand,
  };
}
