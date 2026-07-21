import { registerProductSurfaceCommands } from "@lightmem2/product-surface";
import { TOKENPILOT_PRODUCT_SURFACE_IDENTITY } from "@lightmem2/tokenpilot";
import { openClawProductSurfaceConfigAdapter } from "./tokenpilot/host-config-adapter.js";
import { createOpenClawProductSurfaceBridge } from "./tokenpilot/openclaw-command-bridge.js";
import { createOpenClawCommandRegistrar } from "./tokenpilot/openclaw-command-registrar.js";

export function registerTokenPilotCommand(api: any, logger: { debug?: (...args: unknown[]) => void }): void {
  if (typeof api.registerCommand !== "function") {
    logger.debug?.("[plugin-runtime] registerCommand unavailable; /tokenpilot not registered.");
    return;
  }

  registerProductSurfaceCommands({
    registrar: createOpenClawCommandRegistrar(api),
    bridge: createOpenClawProductSurfaceBridge(api),
    configAdapter: openClawProductSurfaceConfigAdapter,
    identity: TOKENPILOT_PRODUCT_SURFACE_IDENTITY,
  });
  logger.debug?.("[plugin-runtime] Registered /tokenpilot, /lightmem2, and /tp commands.");
}
