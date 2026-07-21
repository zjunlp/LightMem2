import type {
  ProductCommandRegistrar,
  ProductSurfaceConfigAdapter,
  ProductSurfaceHostBridge,
} from "@lightmem2/host-adapter";
import { createProductSurfaceCommandHandler } from "./commands.js";
import type { ProductSurfaceIdentity } from "./identity.js";

export function registerProductSurfaceCommands(params: {
  registrar: ProductCommandRegistrar;
  bridge: ProductSurfaceHostBridge;
  configAdapter: ProductSurfaceConfigAdapter;
  identity: ProductSurfaceIdentity;
}): void {
  const handler = createProductSurfaceCommandHandler({
    bridge: params.bridge,
    configAdapter: params.configAdapter,
    identity: params.identity,
  });

  for (const alias of params.identity.aliases) {
    params.registrar.registerCommand({
      name: alias.name,
      description: alias.description,
      acceptsArgs: true,
      handler,
    });
  }
}
