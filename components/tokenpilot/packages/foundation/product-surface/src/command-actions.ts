import type { TokenPilotProductSurfaceConfigAdapter, TokenPilotProductSurfaceHostBridge } from "@tokenpilot/host-adapter";
import { createEvictionHandler } from "./commands/runtime-eviction.js";
import { createModeHandler } from "./commands/runtime-mode.js";
import { createReductionHandler } from "./commands/runtime-reduction.js";
import { createSettingsHandler } from "./commands/runtime-settings.js";
import { createStabilizerHandler } from "./commands/runtime-stabilizer.js";
import { createHostActionHandlers } from "./commands/host.js";
import type { ProductSurfaceActionHandler, ProductSurfaceCommandDeps } from "./commands/shared.js";

export function createProductSurfaceActionHandlers(params: {
  bridge: TokenPilotProductSurfaceHostBridge;
  configAdapter: TokenPilotProductSurfaceConfigAdapter;
}): Record<string, ProductSurfaceActionHandler> {
  const deps: ProductSurfaceCommandDeps = params;

  return {
    ...createHostActionHandlers(deps),
    mode: createModeHandler(deps),
    settings: createSettingsHandler(deps),
    stabilizer: createStabilizerHandler(deps),
    reduction: createReductionHandler(deps),
    eviction: createEvictionHandler(deps),
  };
}
