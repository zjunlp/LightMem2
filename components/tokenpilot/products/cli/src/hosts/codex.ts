import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  TokenPilotProductSurfaceConfigAdapter,
  TokenPilotProductSurfaceHostBridge,
} from "@tokenpilot/host-adapter";
import {
  createProductSurfaceCommandHandler,
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
import { readCodexUxSessionAggregate, readLatestCodexUxEffect } from "../../../../adapters/codex/src/ux-effects.js";
import { buildSessionReportResult, resolvePreferredSessionId } from "./shared.js";

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
  const currentConfig = await loadConfig();
  const stateDir = resolveCodexStateDir(currentConfig);
  return resolvePreferredSessionId({
    stateDir,
    resolveLatestSessionId: resolveLatestCodexSessionId,
    readLatestUxEffect: readLatestCodexUxEffect,
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
    readLatestUxEffect: readLatestCodexUxEffect,
  });
}

function splitArgs(raw: string): string[] {
  return raw.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function formatCodexReductionHelp(): string {
  return [
    "Observation Reduction commands (Codex):",
    "lightmem2 codex reduction",
    "lightmem2 codex reduction on",
    "lightmem2 codex reduction off",
    "lightmem2 codex reduction mode <light|balanced|aggressive>",
    "lightmem2 codex reduction pass <name> <on|off>",
    "lightmem2 codex reduction set <triggerMinChars|maxToolChars> <number>",
    "",
    "Supported pass names:",
    ...CODEX_REDUCTION_PASS_NAMES.map((name) => `- ${name}`),
  ].join("\n");
}

function formatCodexHelp(section?: string): string {
  if (section === "stabilizer") {
    return [
      "Prefix Stabilization commands (Codex):",
      "lightmem2 codex stabilizer",
      "lightmem2 codex stabilizer on",
      "lightmem2 codex stabilizer off",
      "lightmem2 codex stabilizer target <developer|user>",
      "",
      "Supported knobs:",
      "- modules.stabilizer",
      "- hooks.dynamicContextTarget",
    ].join("\n");
  }

  if (section === "reduction") {
    return formatCodexReductionHelp();
  }

  return [
    "LightMem2 Codex commands:",
    "",
    "lightmem2 codex status",
    "lightmem2 codex report",
    "lightmem2 codex doctor",
    "lightmem2 codex visual",
    "lightmem2 codex mode <conservative|normal>",
    "lightmem2 codex stabilizer ...",
    "lightmem2 codex reduction ...",
    "",
    "Not supported on Codex yet:",
    "- settings ...",
    "- eviction ...",
    "- mode aggressive",
    "- stabilizer hook ...",
  ].join("\n");
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

function formatCodexStabilizerStatus(currentConfig: Record<string, unknown>): string {
  return [
    "Prefix Stabilization (Codex):",
    `- enabled: ${formatOnOff(getNestedValue(currentConfig, ["modules", "stabilizer"]))}`,
    `- dynamicContextTarget: ${formatDisplayValue(getNestedValue(currentConfig, ["hooks", "dynamicContextTarget"]))}`,
  ].join("\n");
}

function formatCodexReductionStatus(currentConfig: Record<string, unknown>): string {
  const passFlags = CODEX_REDUCTION_PASS_NAMES
    .map((name) => `${name}=${formatOnOff(getNestedValue(currentConfig, ["reduction", "passes", name]))}`)
    .join(", ");
  return [
    "Observation Reduction (Codex):",
    `- enabled: ${formatOnOff(getNestedValue(currentConfig, ["modules", "reduction"]))}`,
    `- triggerMinChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "triggerMinChars"]))}`,
    `- maxToolChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "maxToolChars"]))}`,
    `- passes: ${passFlags}`,
  ].join("\n");
}

function isCodexReductionPassName(value: string): value is typeof CODEX_REDUCTION_PASS_NAMES[number] {
  return (CODEX_REDUCTION_PASS_NAMES as readonly string[]).includes(value);
}

function codexModePreset(mode: "conservative" | "normal"): {
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

async function applyCodexMode(mode: "conservative" | "normal"): Promise<void> {
  const current = await loadConfig();
  const { triggerMinChars, maxToolChars } = codexModePreset(mode);
  const next: Record<string, unknown> = {
    ...current,
    enabled: true,
    modules: {
      ...(typeof current.modules === "object" && current.modules ? current.modules as Record<string, unknown> : {}),
      stabilizer: true,
      reduction: true,
    },
    reduction: {
      ...(typeof current.reduction === "object" && current.reduction ? current.reduction as Record<string, unknown> : {}),
      triggerMinChars,
      maxToolChars,
    },
  };
  await writeConfig(next);
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
        readLatestUxEffect: readLatestCodexUxEffect,
        readSessionAggregate: readCodexUxSessionAggregate,
      });
    },
  };

  const sharedHandler = createProductSurfaceCommandHandler({
    bridge,
    configAdapter: codexProductSurfaceConfigAdapter,
  });

  async function handleCommand(ctx: { args: string; sessionId?: string }): Promise<{ text: string }> {
    const args = splitArgs(ctx.args);
    const action = args[0]?.toLowerCase() ?? "";

    if (!action) {
      return { text: `${formatCodexStatus(await loadConfig())}\n\n${formatCodexHelp()}` };
    }

    if (action === "help") {
      return { text: formatCodexHelp(args[1]?.toLowerCase()) };
    }

    if (action === "status") {
      return { text: formatCodexStatus(await loadConfig()) };
    }

    if (action === "report" || action === "doctor" || action === "visual") {
      return sharedHandler(ctx);
    }

    if (action === "reduction") {
      const sub = args[1]?.toLowerCase() ?? "";
      if (!sub || sub === "status" || sub === "show") {
        return { text: formatCodexReductionStatus(await loadConfig()) };
      }
      if (sub === "help") {
        return { text: formatCodexReductionHelp() };
      }
      if (sub === "pass") {
        const passName = args[2] ?? "";
        if (!isCodexReductionPassName(passName)) {
          return { text: `Codex reduction supports only these passes: ${CODEX_REDUCTION_PASS_NAMES.join(", ")}` };
        }
      }
      return sharedHandler(ctx);
    }

    if (action === "stabilizer") {
      const sub = args[1]?.toLowerCase() ?? "";
      if (!sub || sub === "status" || sub === "show") {
        return { text: formatCodexStabilizerStatus(await loadConfig()) };
      }
      if (sub === "help") {
        return { text: formatCodexHelp("stabilizer") };
      }
      if (sub === "on" || sub === "off" || sub === "target") {
        return sharedHandler(ctx);
      }
      return { text: "Codex currently supports only `stabilizer on|off` and `stabilizer target <developer|user>`." };
    }

    if (action === "mode") {
      const mode = args[1]?.toLowerCase() ?? "";
      if (mode === "conservative" || mode === "normal") {
        await applyCodexMode(mode);
        return { text: `✅ Runtime mode = ${mode}` };
      }
      if (mode === "aggressive") {
        return { text: "Codex does not support lifecycle eviction mode. Use `mode normal` or `mode conservative`." };
      }
      return { text: "Usage: lightmem2 codex mode <conservative|normal>" };
    }

    if (action === "settings") {
      return { text: "Codex does not expose shared runtime settings yet." };
    }

    if (action === "eviction") {
      return { text: "Codex lifecycle eviction controls are not supported." };
    }

    return { text: "Unsupported Codex command. Supported commands: status, report, doctor, visual, mode <conservative|normal>, reduction ..., stabilizer on|off|target." };
  }

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
