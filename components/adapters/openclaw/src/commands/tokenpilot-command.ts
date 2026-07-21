import { registerProductSurfaceCommands } from "@lightmem2/product-surface";
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
  });
  logger.debug?.("[plugin-runtime] Registered /tokenpilot, /lightmem2, and /tp commands.");
}
