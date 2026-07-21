import { formatOnOff, getNestedValue, parseBooleanWord, setNestedValue, splitArgs } from "../config.js";
import type { ProductSurfaceActionHandler, ProductSurfaceCommandDeps } from "./shared.js";
import { writeUpdatedConfig } from "./shared.js";

export function createSettingsHandler(params: ProductSurfaceCommandDeps): ProductSurfaceActionHandler {
  const { bridge, configAdapter, identity } = params;

  return async (_ctx, currentConfig, rest) => {
    const args = splitArgs(rest);
    const key = args[0]?.toLowerCase() ?? "";

    if (!key) {
      const pluginCfg = configAdapter.pluginConfigRecord(currentConfig);
      return {
        text: [
          `${identity.displayName} settings:`,
          `- details: ${formatOnOff(getNestedValue(pluginCfg, ["ux", "details"]))}`,
        ].join("\n"),
      };
    }

    if (key === "details") {
      const value = parseBooleanWord(args[1] ?? "");
      if (value === undefined) {
        return { text: `Usage: /${identity.commandName} settings details <on|off>` };
      }
      return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
        const pluginCfg = configAdapter.ensurePluginConfig(nextConfig);
        setNestedValue(pluginCfg, ["ux", "details"], value);
        return `✅ ux.details = ${value}`;
      });
    }

    return { text: `Usage: /${identity.commandName} settings details <on|off>` };
  };
}
