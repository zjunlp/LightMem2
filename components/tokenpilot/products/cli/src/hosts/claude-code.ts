import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  TokenPilotProductSurfaceConfigAdapter,
  TokenPilotProductSurfaceHostBridge,
} from "@tokenpilot/host-adapter";
import {
  createProductSurfaceCommandHandler,
  formatSessionReport,
  getNestedValue,
  formatDisplayValue,
  formatOnOff,
} from "@tokenpilot/product-surface";
import {
  defaultClaudeCodeMcpConfigPath,
  defaultClaudeCodeSettingsPath,
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
  normalizeTokenPilotClaudeCodeConfig,
  writeTokenPilotClaudeCodeConfig,
} from "../../../../adapters/claude-code/src/config.js";
import {
  inspectClaudeCodeDoctor,
  formatClaudeCodeDoctorReport,
} from "../../../../adapters/claude-code/src/doctor.js";
import {
  claudeCodeProductSurfaceConfigAdapter,
  resolveClaudeCodeStateDir,
} from "../../../../adapters/claude-code/src/host-config-adapter.js";
import { resolveLatestClaudeCodeSessionId } from "../../../../adapters/claude-code/src/session-state.js";
import { renderClaudeCodeSessionVisual } from "../../../../adapters/claude-code/src/session-visual.js";
import {
  readClaudeCodeUxSessionAggregate,
  readLatestClaudeCodeUxEffect,
} from "../../../../adapters/claude-code/src/ux-effects.js";

const CLAUDE_REDUCTION_PASS_NAMES = [
  "readStateCompaction",
  "toolPayloadTrim",
  "htmlSlimming",
  "execOutputTruncation",
  "agentsStartupOptimization",
] as const;

function normalizeSessionId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

async function loadConfig(): Promise<Record<string, unknown>> {
  return loadTokenPilotClaudeCodeConfig(defaultTokenPilotClaudeCodeConfigPath()) as unknown as Record<string, unknown>;
}

async function writeConfig(nextConfig: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(defaultTokenPilotClaudeCodeConfigPath()), { recursive: true });
  await writeTokenPilotClaudeCodeConfig(
    normalizeTokenPilotClaudeCodeConfig(nextConfig),
    defaultTokenPilotClaudeCodeConfigPath(),
  );
}

async function maybeResolveLatestSessionId(): Promise<string | undefined> {
  const currentConfig = await loadConfig();
  const stateDir = resolveClaudeCodeStateDir(currentConfig);
  if (!stateDir) return undefined;
  return normalizeSessionId(await resolveLatestClaudeCodeSessionId(stateDir))
    ?? normalizeSessionId((await readLatestClaudeCodeUxEffect(stateDir))?.sessionId);
}

function splitArgs(raw: string): string[] {
  return raw.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function formatClaudeCodeReductionHelp(): string {
  return [
    "Observation Reduction commands (Claude Code):",
    "lightmem2 claude-code reduction",
    "lightmem2 claude-code reduction on",
    "lightmem2 claude-code reduction off",
    "lightmem2 claude-code reduction mode <light|balanced|aggressive>",
    "lightmem2 claude-code reduction pass <name> <on|off>",
    "lightmem2 claude-code reduction set <triggerMinChars|maxToolChars> <number>",
    "",
    "Supported pass names:",
    ...CLAUDE_REDUCTION_PASS_NAMES.map((name) => `- ${name}`),
  ].join("\n");
}

function formatClaudeCodeHelp(section?: string): string {
  if (section === "stabilizer") {
    return [
      "Prefix Stabilization commands (Claude Code):",
      "lightmem2 claude-code stabilizer",
      "lightmem2 claude-code stabilizer on",
      "lightmem2 claude-code stabilizer off",
      "lightmem2 claude-code stabilizer target <developer|user>",
      "",
      "Supported knobs:",
      "- modules.stabilizer",
      "- hooks.dynamicContextTarget",
    ].join("\n");
  }

  if (section === "reduction") {
    return formatClaudeCodeReductionHelp();
  }

  return [
    "LightMem2 Claude Code commands:",
    "",
    "lightmem2 claude-code status",
    "lightmem2 claude-code report",
    "lightmem2 claude-code doctor",
    "lightmem2 claude-code visual",
    "lightmem2 claude-code mode <conservative|normal>",
    "lightmem2 claude-code stabilizer ...",
    "lightmem2 claude-code reduction ...",
    "",
    "Not supported on Claude Code yet:",
    "- settings ...",
    "- eviction ...",
    "- mode aggressive",
    "- stabilizer hook ...",
  ].join("\n");
}

function formatClaudeCodeStatus(currentConfig: Record<string, unknown>): string {
  return [
    "TokenPilot Claude Code status:",
    `- enabled: ${formatOnOff(currentConfig.enabled)}`,
    `- stabilizer: ${formatOnOff(getNestedValue(currentConfig, ["modules", "stabilizer"]))}`,
    `- dynamicContextTarget: ${formatDisplayValue(getNestedValue(currentConfig, ["hooks", "dynamicContextTarget"]))}`,
    `- reduction: ${formatOnOff(getNestedValue(currentConfig, ["modules", "reduction"]))}`,
    `- triggerMinChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "triggerMinChars"]))}`,
    `- maxToolChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "maxToolChars"]))}`,
    `- proxyPort: ${formatDisplayValue(currentConfig.proxyPort)}`,
    `- upstreamBaseUrl: ${formatDisplayValue(currentConfig.upstreamBaseUrl)}`,
  ].join("\n");
}

function formatClaudeCodeStabilizerStatus(currentConfig: Record<string, unknown>): string {
  return [
    "Prefix Stabilization (Claude Code):",
    `- enabled: ${formatOnOff(getNestedValue(currentConfig, ["modules", "stabilizer"]))}`,
    `- dynamicContextTarget: ${formatDisplayValue(getNestedValue(currentConfig, ["hooks", "dynamicContextTarget"]))}`,
  ].join("\n");
}

function formatClaudeCodeReductionStatus(currentConfig: Record<string, unknown>): string {
  const passFlags = CLAUDE_REDUCTION_PASS_NAMES
    .map((name) => `${name}=${formatOnOff(getNestedValue(currentConfig, ["reduction", "passes", name]))}`)
    .join(", ");
  return [
    "Observation Reduction (Claude Code):",
    `- enabled: ${formatOnOff(getNestedValue(currentConfig, ["modules", "reduction"]))}`,
    `- triggerMinChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "triggerMinChars"]))}`,
    `- maxToolChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "maxToolChars"]))}`,
    `- passes: ${passFlags}`,
  ].join("\n");
}

function isClaudeReductionPassName(value: string): value is typeof CLAUDE_REDUCTION_PASS_NAMES[number] {
  return (CLAUDE_REDUCTION_PASS_NAMES as readonly string[]).includes(value);
}

function claudeCodeModePreset(mode: "conservative" | "normal"): {
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

async function applyClaudeCodeMode(mode: "conservative" | "normal"): Promise<void> {
  const current = await loadConfig();
  const { triggerMinChars, maxToolChars } = claudeCodeModePreset(mode);
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

export function createClaudeCodeCliBridge(target: {
  host: "claude-code";
  sessionId?: string;
}): {
  bridge: TokenPilotProductSurfaceHostBridge;
  configAdapter: TokenPilotProductSurfaceConfigAdapter;
  maybeResolveLatestSessionId(): Promise<string | undefined>;
  handleCommand(ctx: { args: string; sessionId?: string }): Promise<{ text: string }>;
} {
  const bridge: TokenPilotProductSurfaceHostBridge = {
    loadConfig,
    writeConfig,
    async handleDoctor(currentConfig) {
      const config = currentConfig as any;
      const report = await inspectClaudeCodeDoctor({
        config,
        settingsPath: defaultClaudeCodeSettingsPath(),
        tokenPilotConfigPath: defaultTokenPilotClaudeCodeConfigPath(),
        mcpConfigPath: defaultClaudeCodeMcpConfigPath(),
      });
      return {
        text: formatClaudeCodeDoctorReport(report),
      };
    },
    async handleVisual(currentConfig) {
      const stateDir = resolveClaudeCodeStateDir(currentConfig);
      if (!stateDir) {
        return { text: "TokenPilot stateDir is not configured." };
      }
      const sessionId = normalizeSessionId(target.sessionId) ?? await resolveLatestClaudeCodeSessionId(stateDir);
      return {
        text: await renderClaudeCodeSessionVisual(stateDir, sessionId),
      };
    },
    async handleReport(_ctx, currentConfig) {
      const stateDir = resolveClaudeCodeStateDir(currentConfig);
      if (!stateDir) {
        return { text: "TokenPilot stateDir is not configured." };
      }
      const latest = await readLatestClaudeCodeUxEffect(stateDir);
      const sessionId = normalizeSessionId(target.sessionId)
        ?? normalizeSessionId(latest?.sessionId)
        ?? await resolveLatestClaudeCodeSessionId(stateDir);
      if (!sessionId) {
        return { text: "No TokenPilot session stats yet." };
      }
      const aggregate = await readClaudeCodeUxSessionAggregate(stateDir, sessionId);
      if (!aggregate) {
        return { text: `No TokenPilot savings recorded yet for session ${sessionId}.` };
      }
      const pluginCfg = claudeCodeProductSurfaceConfigAdapter.pluginConfigRecord(currentConfig);
      const detailsEnabled = getNestedValue(pluginCfg, ["ux", "details"]) === true;
      return {
        text: formatSessionReport({
          sessionId,
          aggregate,
          latest,
          detailsEnabled,
        }),
      };
    },
  };

  const sharedHandler = createProductSurfaceCommandHandler({
    bridge,
    configAdapter: claudeCodeProductSurfaceConfigAdapter,
  });

  async function handleCommand(ctx: { args: string; sessionId?: string }): Promise<{ text: string }> {
    const args = splitArgs(ctx.args);
    const action = args[0]?.toLowerCase() ?? "";

    if (!action) {
      return { text: `${formatClaudeCodeStatus(await loadConfig())}\n\n${formatClaudeCodeHelp()}` };
    }

    if (action === "help") {
      return { text: formatClaudeCodeHelp(args[1]?.toLowerCase()) };
    }

    if (action === "status") {
      return { text: formatClaudeCodeStatus(await loadConfig()) };
    }

    if (action === "report" || action === "doctor" || action === "visual") {
      return sharedHandler(ctx);
    }

    if (action === "reduction") {
      const sub = args[1]?.toLowerCase() ?? "";
      if (!sub || sub === "status" || sub === "show") {
        return { text: formatClaudeCodeReductionStatus(await loadConfig()) };
      }
      if (sub === "help") {
        return { text: formatClaudeCodeReductionHelp() };
      }
      if (sub === "pass") {
        const passName = args[2] ?? "";
        if (!isClaudeReductionPassName(passName)) {
          return { text: `Claude Code reduction supports only these passes: ${CLAUDE_REDUCTION_PASS_NAMES.join(", ")}` };
        }
      }
      return sharedHandler(ctx);
    }

    if (action === "stabilizer") {
      const sub = args[1]?.toLowerCase() ?? "";
      if (!sub || sub === "status" || sub === "show") {
        return { text: formatClaudeCodeStabilizerStatus(await loadConfig()) };
      }
      if (sub === "help") {
        return { text: formatClaudeCodeHelp("stabilizer") };
      }
      if (sub === "on" || sub === "off" || sub === "target") {
        return sharedHandler(ctx);
      }
      return { text: "Claude Code currently supports only `stabilizer on|off` and `stabilizer target <developer|user>`." };
    }

    if (action === "mode") {
      const mode = args[1]?.toLowerCase() ?? "";
      if (mode === "conservative" || mode === "normal") {
        await applyClaudeCodeMode(mode);
        return { text: `✅ Runtime mode = ${mode}` };
      }
      if (mode === "aggressive") {
        return { text: "Claude Code does not support lifecycle eviction mode. Use `mode normal` or `mode conservative`." };
      }
      return { text: "Usage: lightmem2 claude-code mode <conservative|normal>" };
    }

    if (action === "settings") {
      return { text: "Claude Code does not expose shared runtime settings yet." };
    }

    if (action === "eviction") {
      return { text: "Claude Code lifecycle eviction controls are not supported." };
    }

    return { text: "Unsupported Claude Code command. Supported commands: status, report, doctor, visual, mode <conservative|normal>, reduction ..., stabilizer on|off|target." };
  }

  return {
    bridge,
    configAdapter: claudeCodeProductSurfaceConfigAdapter,
    maybeResolveLatestSessionId,
    handleCommand,
  };
}
