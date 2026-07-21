import type {
  TokenPilotProductCommandRegistrar,
  TokenPilotProductSurfaceConfigAdapter,
  TokenPilotProductSurfaceHostBridge,
} from "@lightmem2/host-adapter";
import { createProductSurfaceCommandHandler } from "./commands.js";

export type TokenPilotCommandAliasSpec = {
  name: string;
  description: string;
};

export const DEFAULT_TOKENPILOT_COMMAND_ALIASES: TokenPilotCommandAliasSpec[] = [
  {
    name: "tokenpilot",
    description: "Manage TokenPilot runtime knobs by module.",
  },
  {
    name: "lightmem2",
    description: "LightMem2 command surface. Compatible alias for /tokenpilot.",
  },
  {
    name: "tp",
    description: "Alias for /tokenpilot.",
  },
];

export function registerProductSurfaceCommands(params: {
  registrar: TokenPilotProductCommandRegistrar;
  bridge: TokenPilotProductSurfaceHostBridge;
  configAdapter: TokenPilotProductSurfaceConfigAdapter;
  aliases?: TokenPilotCommandAliasSpec[];
}): void {
  const handler = createProductSurfaceCommandHandler({
    bridge: params.bridge,
    configAdapter: params.configAdapter,
  });

  for (const alias of params.aliases ?? DEFAULT_TOKENPILOT_COMMAND_ALIASES) {
    params.registrar.registerCommand({
      name: alias.name,
      description: alias.description,
      acceptsArgs: true,
      handler,
    });
  }
}
