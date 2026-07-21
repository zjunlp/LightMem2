import { parseBooleanWord, parseStringValue, setNestedValue, splitArgs } from "../config.js";
import { formatTokenPilotHelp, summarizeStabilizerStatus } from "../presentation.js";
import type { ProductSurfaceActionHandler, ProductSurfaceCommandDeps } from "./shared.js";
import { writeUpdatedConfig } from "./shared.js";

export function createStabilizerHandler(params: ProductSurfaceCommandDeps): ProductSurfaceActionHandler {
  const { bridge, configAdapter } = params;

  return async (_ctx, currentConfig, rest) => {
    const args = splitArgs(rest);
    const action = args[0]?.toLowerCase() ?? "status";

    if (action === "status" || action === "show") {
      return { text: summarizeStabilizerStatus(currentConfig, configAdapter) };
    }

    if (action === "help") {
      return { text: formatTokenPilotHelp("stabilizer") };
    }

    const toggleValue = parseBooleanWord(action);
    if (toggleValue !== undefined) {
      return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
        const pluginCfg = configAdapter.ensurePluginConfig(nextConfig);
        const entry = configAdapter.ensurePluginEntry(nextConfig);
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
      return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
        const pluginCfg = configAdapter.ensurePluginConfig(nextConfig);
        setNestedValue(pluginCfg, ["hooks", "beforeToolCall"], value);
        return `✅ hooks.beforeToolCall = ${value}`;
      });
    }

    if (action === "target") {
      const target = parseStringValue(args[1] ?? "").toLowerCase();
      if (target !== "developer" && target !== "user") {
        return { text: "Usage: /tokenpilot stabilizer target <developer|user>" };
      }
      return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
        const pluginCfg = configAdapter.ensurePluginConfig(nextConfig);
        setNestedValue(pluginCfg, ["hooks", "dynamicContextTarget"], target);
        return `✅ hooks.dynamicContextTarget = ${target}`;
      });
    }

    return { text: formatTokenPilotHelp("stabilizer") };
  };
}
