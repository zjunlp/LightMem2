import type {
  TokenPilotProductSurfaceConfigAdapter,
  TokenPilotProductSurfaceHostBridge,
} from "@lightmem2/host-adapter";
import { parseCommandAction } from "./config.js";
import { formatTokenPilotHelp, summarizeTokenPilotStatus } from "./presentation.js";
import { createProductSurfaceActionHandlers } from "./command-actions.js";

export function createProductSurfaceCommandHandler(params: {
  bridge: TokenPilotProductSurfaceHostBridge;
  configAdapter: TokenPilotProductSurfaceConfigAdapter;
}) {
  const { bridge, configAdapter } = params;
  const actionHandlers = createProductSurfaceActionHandlers({
    bridge,
    configAdapter,
  });

  return async (ctx: any) => {
    const rawArgs = typeof ctx?.args === "string" ? ctx.args : "";
    const { action, rest } = parseCommandAction(rawArgs);
    const currentConfig = await bridge.loadConfig();

    if (!action || action === "help") {
      return action === "help"
        ? actionHandlers.help(ctx, currentConfig, rest)
        : { text: `${summarizeTokenPilotStatus(currentConfig, configAdapter)}\n\n${formatTokenPilotHelp()}` };
    }

    const handler = actionHandlers[action];
    if (!handler) {
      return { text: formatTokenPilotHelp() };
    }

    return handler(ctx, currentConfig, rest);
  };
}
