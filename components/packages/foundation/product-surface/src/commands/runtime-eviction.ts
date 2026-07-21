import { parseBooleanWord, parseNumberWord, parseStringValue, setNestedValue, splitArgs } from "../config.js";
import { formatTokenPilotHelp, summarizeEvictionStatus } from "../presentation.js";
import type { ProductSurfaceActionHandler, ProductSurfaceCommandDeps } from "./shared.js";
import { writeUpdatedConfig } from "./shared.js";

export function createEvictionHandler(params: ProductSurfaceCommandDeps): ProductSurfaceActionHandler {
  const { bridge, configAdapter } = params;

  return async (_ctx, currentConfig, rest) => {
    const args = splitArgs(rest);
    const action = args[0]?.toLowerCase() ?? "status";

    if (action === "status" || action === "show") {
      return { text: summarizeEvictionStatus(currentConfig, configAdapter) };
    }

    if (action === "help") {
      return { text: formatTokenPilotHelp("eviction") };
    }

    const toggleValue = parseBooleanWord(action);
    if (toggleValue !== undefined) {
      return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
        const pluginCfg = configAdapter.ensurePluginConfig(nextConfig);
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
      return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
        const pluginCfg = configAdapter.ensurePluginConfig(nextConfig);
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

      return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
        const pluginCfg = configAdapter.ensurePluginConfig(nextConfig);
        setNestedValue(pluginCfg, targetPath, parsedValue);
        return `✅ ${targetPath.join(".")} = ${parsedValue}`;
      });
    }

    return { text: formatTokenPilotHelp("eviction") };
  };
}
