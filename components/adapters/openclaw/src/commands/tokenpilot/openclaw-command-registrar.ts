import type { TokenPilotProductCommandRegistrar, TokenPilotRegisteredCommandSpec } from "@lightmem2/host-adapter";

export function createOpenClawCommandRegistrar(api: any): TokenPilotProductCommandRegistrar {
  return {
    registerCommand(spec: TokenPilotRegisteredCommandSpec) {
      api.registerCommand(spec);
    },
  };
}
