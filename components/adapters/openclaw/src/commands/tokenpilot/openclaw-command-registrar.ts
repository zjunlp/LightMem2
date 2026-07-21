import type { ProductCommandRegistrar, ProductCommandSpec } from "@lightmem2/host-adapter";

export function createOpenClawCommandRegistrar(api: any): ProductCommandRegistrar {
  return {
    registerCommand(spec: ProductCommandSpec) {
      api.registerCommand(spec);
    },
  };
}
