import { handleReport } from "./tokenpilot/session-report.js";
import {
  formatTokenPilotHelp,
  summarizeEvictionStatus,
  summarizeReductionStatus,
  summarizeStabilizerStatus,
  summarizeTokenPilotStatus,
} from "./tokenpilot/presentation.js";
import {
  REDUCTION_PASS_PATHS,
  REDUCTION_PRESETS,
  applyReductionPreset,
  ensurePluginConfig,
  ensurePluginEntry,
  formatOnOff,
  getNestedValue,
  parseBooleanWord,
  parseCommandAction,
  parseNumberWord,
  parseStringValue,
  pluginConfigRecord,
  setNestedValue,
  splitArgs,
  writeUpdatedConfig,
} from "./tokenpilot/shared.js";

function handleHelp(rest: string): { text: string } {
  const section = splitArgs(rest)[0]?.toLowerCase();
  return { text: formatTokenPilotHelp(section) };
}

async function handleStabilizer(api: any, currentConfig: Record<string, unknown>, rest: string): Promise<{ text: string }> {
  const args = splitArgs(rest);
  const action = args[0]?.toLowerCase() ?? "status";

  if (action === "status" || action === "show") {
    return { text: summarizeStabilizerStatus(currentConfig) };
  }

  if (action === "help") {
    return { text: formatTokenPilotHelp("stabilizer") };
  }

  const toggleValue = parseBooleanWord(action);
  if (toggleValue !== undefined) {
    return writeUpdatedConfig(api, currentConfig, (nextConfig) => {
      const pluginCfg = ensurePluginConfig(nextConfig);
      const entry = ensurePluginEntry(nextConfig);
      entry.enabled = true;
      pluginCfg.enabled = true;
      setNestedValue(pluginCfg, ["modules", "stabilizer"], toggleValue);
      return `✅ Prefix Stabilization ${toggleValue ? "enabled" : "disabled"}`;
    });
  }

  if (action === "hook") {
    const value = parseBooleanWord(args[1] ?? "");
    if (value === undefined) {
      return { text: "Usage: /tokenpilot stabilizer hook <on|off>" };
    }
    return writeUpdatedConfig(api, currentConfig, (nextConfig) => {
      const pluginCfg = ensurePluginConfig(nextConfig);
      setNestedValue(pluginCfg, ["hooks", "beforeToolCall"], value);
      return `✅ hooks.beforeToolCall = ${value}`;
    });
  }

  if (action === "target") {
    const target = parseStringValue(args[1] ?? "").toLowerCase();
    if (target !== "developer" && target !== "user") {
      return { text: "Usage: /tokenpilot stabilizer target <developer|user>" };
    }
    return writeUpdatedConfig(api, currentConfig, (nextConfig) => {
      const pluginCfg = ensurePluginConfig(nextConfig);
      setNestedValue(pluginCfg, ["hooks", "dynamicContextTarget"], target);
      return `✅ hooks.dynamicContextTarget = ${target}`;
    });
  }

  return { text: formatTokenPilotHelp("stabilizer") };
}

async function handleReduction(api: any, currentConfig: Record<string, unknown>, rest: string): Promise<{ text: string }> {
  const args = splitArgs(rest);
  const action = args[0]?.toLowerCase() ?? "status";

  if (action === "status" || action === "show") {
    return { text: summarizeReductionStatus(currentConfig) };
  }

  if (action === "help") {
    return { text: formatTokenPilotHelp("reduction") };
  }

  const toggleValue = parseBooleanWord(action);
  if (toggleValue !== undefined) {
    return writeUpdatedConfig(api, currentConfig, (nextConfig) => {
      const pluginCfg = ensurePluginConfig(nextConfig);
      setNestedValue(pluginCfg, ["modules", "reduction"], toggleValue);
      return `✅ Observation Reduction ${toggleValue ? "enabled" : "disabled"}`;
    });
  }

  if (action === "mode") {
    const presetName = parseStringValue(args[1] ?? "").toLowerCase();
    if (!REDUCTION_PRESETS[presetName]) {
      return { text: "Usage: /tokenpilot reduction mode <light|balanced|aggressive>" };
    }
    return writeUpdatedConfig(api, currentConfig, (nextConfig) => {
      applyReductionPreset(nextConfig, presetName);
      return `✅ Observation Reduction preset = ${presetName}`;
    });
  }

  if (action === "pass") {
    const passName = args[1] ?? "";
    const passPath = REDUCTION_PASS_PATHS[passName];
    const value = parseBooleanWord(args[2] ?? "");
    if (!passPath || value === undefined) {
      return { text: "Usage: /tokenpilot reduction pass <name> <on|off>" };
    }
    return writeUpdatedConfig(api, currentConfig, (nextConfig) => {
      const pluginCfg = ensurePluginConfig(nextConfig);
      setNestedValue(pluginCfg, passPath, value);
      return `✅ reduction.${passName} = ${value}`;
    });
  }

  if (action === "set") {
    const key = args[1] ?? "";
    const value = parseNumberWord(args[2] ?? "");
    if ((key !== "triggerMinChars" && key !== "maxToolChars") || value === undefined) {
      return { text: "Usage: /tokenpilot reduction set <triggerMinChars|maxToolChars> <number>" };
    }
    return writeUpdatedConfig(api, currentConfig, (nextConfig) => {
      const pluginCfg = ensurePluginConfig(nextConfig);
      setNestedValue(pluginCfg, ["reduction", key], value);
      return `✅ reduction.${key} = ${value}`;
    });
  }

  return { text: formatTokenPilotHelp("reduction") };
}

async function handleEviction(api: any, currentConfig: Record<string, unknown>, rest: string): Promise<{ text: string }> {
  const args = splitArgs(rest);
  const action = args[0]?.toLowerCase() ?? "status";

  if (action === "status" || action === "show") {
    return { text: summarizeEvictionStatus(currentConfig) };
  }

  if (action === "help") {
    return { text: formatTokenPilotHelp("eviction") };
  }

  const toggleValue = parseBooleanWord(action);
  if (toggleValue !== undefined) {
    return writeUpdatedConfig(api, currentConfig, (nextConfig) => {
      const pluginCfg = ensurePluginConfig(nextConfig);
      setNestedValue(pluginCfg, ["modules", "eviction"], toggleValue);
      setNestedValue(pluginCfg, ["eviction", "enabled"], toggleValue);
      setNestedValue(pluginCfg, ["taskStateEstimator", "enabled"], toggleValue);
      return `✅ Lifecycle-Aware Eviction ${toggleValue ? "enabled" : "disabled"}`;
    });
  }

  if (action === "estimator") {
    const value = parseBooleanWord(args[1] ?? "");
    if (value === undefined) {
      return { text: "Usage: /tokenpilot eviction estimator <on|off>" };
    }
    return writeUpdatedConfig(api, currentConfig, (nextConfig) => {
      const pluginCfg = ensurePluginConfig(nextConfig);
      setNestedValue(pluginCfg, ["taskStateEstimator", "enabled"], value);
      return `✅ taskStateEstimator.enabled = ${value}`;
    });
  }

  if (action === "set") {
    const key = args[1] ?? "";
    const rawValue = args[2] ?? "";

    const numericKeys = new Set([
      "minBlockChars",
      "maxCandidateBlocks",
      "batchTurns",
      "evictionLookaheadTurns",
      "completedSummaryMaxRawTurns",
      "evictionPromotionHotTailSize",
    ]);
    const enumKeys = new Set(["policy", "replacementMode", "inputMode", "lifecycleMode", "evidenceMode"]);

    if (!numericKeys.has(key) && !enumKeys.has(key)) {
      return { text: "Usage: /tokenpilot eviction set <key> <value>" };
    }

    let parsedValue: string | number | undefined;
    if (numericKeys.has(key)) parsedValue = parseNumberWord(rawValue);
    if (enumKeys.has(key)) parsedValue = parseStringValue(rawValue);
    if (parsedValue === undefined || parsedValue === "") {
      return { text: "Usage: /tokenpilot eviction set <key> <value>" };
    }

    const targetPath = key === "policy" || key === "replacementMode" || key === "minBlockChars" || key === "maxCandidateBlocks"
      ? ["eviction", key]
      : ["taskStateEstimator", key];

    return writeUpdatedConfig(api, currentConfig, (nextConfig) => {
      const pluginCfg = ensurePluginConfig(nextConfig);
      setNestedValue(pluginCfg, targetPath, parsedValue);
      return `✅ ${targetPath.join(".")} = ${parsedValue}`;
    });
  }

  return { text: formatTokenPilotHelp("eviction") };
}

async function handleSettings(api: any, currentConfig: Record<string, unknown>, rest: string): Promise<{ text: string }> {
  const args = splitArgs(rest);
  const key = args[0]?.toLowerCase() ?? "";

  if (!key) {
    const pluginCfg = pluginConfigRecord(currentConfig);
    return {
      text: [
        "TokenPilot settings:",
        `- details: ${formatOnOff(getNestedValue(pluginCfg, ["ux", "details"]))}`,
      ].join("\n"),
    };
  }

  if (key === "details") {
    const value = parseBooleanWord(args[1] ?? "");
    if (value === undefined) {
      return { text: "Usage: /tokenpilot settings details <on|off>" };
    }
    return writeUpdatedConfig(api, currentConfig, (nextConfig) => {
      const pluginCfg = ensurePluginConfig(nextConfig);
      setNestedValue(pluginCfg, ["ux", "details"], value);
      return `✅ ux.details = ${value}`;
    });
  }

  return { text: "Usage: /tokenpilot settings details <on|off>" };
}

export function registerTokenPilotCommand(api: any, logger: { debug?: (...args: unknown[]) => void }): void {
  if (typeof api.registerCommand !== "function") {
    logger.debug?.("[plugin-runtime] registerCommand unavailable; /tokenpilot not registered.");
    return;
  }

  const handler = async (ctx: any) => {
    const rawArgs = typeof ctx?.args === "string" ? ctx.args : "";
    const { action, rest } = parseCommandAction(rawArgs);
    const currentConfig = api.runtime.config.loadConfig() as Record<string, unknown>;

    if (!action || action === "help") {
      return action === "help" ? handleHelp(rest) : { text: `${summarizeTokenPilotStatus(currentConfig)}\n\n${formatTokenPilotHelp()}` };
    }

    if (action === "status") {
      return { text: summarizeTokenPilotStatus(currentConfig) };
    }

    if (action === "report") {
      return handleReport(ctx, currentConfig);
    }

    if (action === "settings") {
      return handleSettings(api, currentConfig, rest);
    }

    if (action === "stabilizer") {
      return handleStabilizer(api, currentConfig, rest);
    }

    if (action === "reduction") {
      return handleReduction(api, currentConfig, rest);
    }

    if (action === "eviction") {
      return handleEviction(api, currentConfig, rest);
    }

    return { text: formatTokenPilotHelp() };
  };

  api.registerCommand({
    name: "tokenpilot",
    description: "Manage TokenPilot runtime knobs by module.",
    acceptsArgs: true,
    handler,
  });
  api.registerCommand({
    name: "tp",
    description: "Alias for /tokenpilot.",
    acceptsArgs: true,
    handler,
  });
  logger.debug?.("[plugin-runtime] Registered /tokenpilot and /tp commands.");
}
