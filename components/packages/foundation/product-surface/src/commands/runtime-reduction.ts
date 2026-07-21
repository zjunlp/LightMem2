import {
  REDUCTION_PASS_PATHS,
  REDUCTION_PRESETS,
  applyReductionPreset,
  parseBooleanWord,
  parseNumberWord,
  parseStringValue,
  setNestedValue,
  splitArgs,
} from "../config.js";
import { formatTokenPilotHelp, summarizeReductionStatus } from "../presentation.js";
import type { ProductSurfaceActionHandler, ProductSurfaceCommandDeps } from "./shared.js";
import { writeUpdatedConfig } from "./shared.js";

export function createReductionHandler(params: ProductSurfaceCommandDeps): ProductSurfaceActionHandler {
  const { bridge, configAdapter } = params;

  return async (_ctx, currentConfig, rest) => {
    const args = splitArgs(rest);
    const action = args[0]?.toLowerCase() ?? "status";

    if (action === "status" || action === "show") {
      return { text: summarizeReductionStatus(currentConfig, configAdapter) };
    }

    if (action === "help") {
      return { text: formatTokenPilotHelp("reduction") };
    }

    const toggleValue = parseBooleanWord(action);
    if (toggleValue !== undefined) {
      return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
        const pluginCfg = configAdapter.ensurePluginConfig(nextConfig);
        setNestedValue(pluginCfg, ["modules", "reduction"], toggleValue);
        return `✅ Observation Reduction ${toggleValue ? "enabled" : "disabled"}`;
      });
    }

    if (action === "mode") {
      const presetName = parseStringValue(args[1] ?? "").toLowerCase();
      if (!REDUCTION_PRESETS[presetName]) {
        return { text: "Usage: /tokenpilot reduction mode <light|balanced|aggressive>" };
      }
      return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
        applyReductionPreset(nextConfig, presetName, configAdapter);
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
      return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
        const pluginCfg = configAdapter.ensurePluginConfig(nextConfig);
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
      return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
        const pluginCfg = configAdapter.ensurePluginConfig(nextConfig);
        setNestedValue(pluginCfg, ["reduction", key], value);
        return `✅ reduction.${key} = ${value}`;
      });
    }

    return { text: formatTokenPilotHelp("reduction") };
  };
}
