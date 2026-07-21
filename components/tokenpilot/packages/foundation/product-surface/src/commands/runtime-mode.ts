import { RUNTIME_MODE_PRESETS, applyRuntimeMode, splitArgs } from "../config.js";
import type { ProductSurfaceActionHandler, ProductSurfaceCommandDeps } from "./shared.js";
import { writeUpdatedConfig } from "./shared.js";

export function createModeHandler(params: ProductSurfaceCommandDeps): ProductSurfaceActionHandler {
  const { bridge, configAdapter } = params;

  return async (_ctx, currentConfig, rest) => {
    const modeName = splitArgs(rest)[0]?.toLowerCase() ?? "";
    if (!RUNTIME_MODE_PRESETS[modeName]) {
      return { text: "Usage: /tokenpilot mode <conservative|normal|aggressive>" };
    }

    return writeUpdatedConfig(bridge, currentConfig, (nextConfig) => {
      applyRuntimeMode(nextConfig, modeName, configAdapter);
      return `✅ Runtime mode = ${modeName}`;
    });
  };
}
