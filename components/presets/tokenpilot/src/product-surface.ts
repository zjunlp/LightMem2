import type { ProductSurfaceIdentity } from "@lightmem2/product-surface";

export const TOKENPILOT_PRODUCT_SURFACE_IDENTITY = {
  displayName: "TokenPilot",
  commandName: "tokenpilot",
  aliases: [
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
  ],
} as const satisfies ProductSurfaceIdentity;
