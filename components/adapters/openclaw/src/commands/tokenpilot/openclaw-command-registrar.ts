import type { TokenPilotProductCommandRegistrar, TokenPilotRegisteredCommandSpec } from "@tokenpilot/host-adapter";

export function createOpenClawCommandRegistrar(api: any): TokenPilotProductCommandRegistrar {
  return {
    registerCommand(spec: TokenPilotRegisteredCommandSpec) {
      api.registerCommand(spec);
    },
  };
}
