import type { ProductSurfaceIdentity } from "../src/index.js";

export const TEST_PRODUCT_SURFACE_IDENTITY = {
  displayName: "TokenPilot",
  commandName: "tokenpilot",
  aliases: [
    { name: "tokenpilot", description: "Primary test command." },
    { name: "lightmem2", description: "Framework alias." },
    { name: "tp", description: "Short alias." },
  ],
} as const satisfies ProductSurfaceIdentity;
