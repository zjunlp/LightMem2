import type {
  ProductSurfaceConfigAdapter,
  ProductSurfaceHostBridge,
} from "@lightmem2/host-adapter";
import { parseCommandAction } from "./config.js";
import { formatProductHelp, summarizeProductStatus } from "./presentation.js";
import { createProductSurfaceActionHandlers } from "./command-actions.js";
import type { ProductSurfaceIdentity } from "./identity.js";

export function createProductSurfaceCommandHandler(params: {
  bridge: ProductSurfaceHostBridge;
  configAdapter: ProductSurfaceConfigAdapter;
  identity: ProductSurfaceIdentity;
}) {
  const { bridge, configAdapter, identity } = params;
  const actionHandlers = createProductSurfaceActionHandlers({
    bridge,
    configAdapter,
    identity,
  });

  return async (ctx: any) => {
    const rawArgs = typeof ctx?.args === "string" ? ctx.args : "";
    const { action, rest } = parseCommandAction(rawArgs);
    const currentConfig = await bridge.loadConfig();

    if (!action || action === "help") {
      return action === "help"
        ? actionHandlers.help(ctx, currentConfig, rest)
        : { text: `${summarizeProductStatus(currentConfig, configAdapter, identity)}\n\n${formatProductHelp(identity)}` };
    }

    const handler = actionHandlers[action];
    if (!handler) {
      return { text: formatProductHelp(identity) };
    }

    return handler(ctx, currentConfig, rest);
  };
}
