import type {
  ProductCommandContext,
  ProductCommandResult,
  ProductSurfacePayload,
  ProductSurfaceConfigAdapter,
  ProductSurfaceHostBridge,
} from "@lightmem2/host-adapter";
import type { ProductSurfaceIdentity } from "../identity.js";

export type ProductSurfaceActionHandler = (
  ctx: ProductCommandContext,
  currentConfig: Record<string, unknown>,
  rest: string,
) => Promise<ProductCommandResult> | ProductCommandResult;

export type ProductSurfaceCommandDeps = {
  bridge: ProductSurfaceHostBridge;
  configAdapter: ProductSurfaceConfigAdapter;
  identity: ProductSurfaceIdentity;
};

export function asTextResult(
  text: string,
  payload?: ProductSurfacePayload,
): ProductCommandResult {
  return payload ? { text, payload } : { text };
}

export async function writeUpdatedConfig(
  bridge: ProductSurfaceHostBridge,
  currentConfig: Record<string, unknown>,
  mutate: (nextConfig: Record<string, unknown>) => string,
): Promise<ProductCommandResult> {
  const nextConfig = structuredClone(currentConfig);
  const message = mutate(nextConfig);
  await bridge.writeConfig(nextConfig);
  return { text: message };
}
