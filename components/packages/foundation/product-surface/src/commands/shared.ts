import type {
  TokenPilotProductCommandContext,
  TokenPilotProductCommandResult,
  TokenPilotProductSurfacePayload,
  TokenPilotProductSurfaceConfigAdapter,
  TokenPilotProductSurfaceHostBridge,
} from "@lightmem2/host-adapter";

export type ProductSurfaceActionHandler = (
  ctx: TokenPilotProductCommandContext,
  currentConfig: Record<string, unknown>,
  rest: string,
) => Promise<TokenPilotProductCommandResult> | TokenPilotProductCommandResult;

export type ProductSurfaceCommandDeps = {
  bridge: TokenPilotProductSurfaceHostBridge;
  configAdapter: TokenPilotProductSurfaceConfigAdapter;
};

export function asTextResult(
  text: string,
  payload?: TokenPilotProductSurfacePayload,
): TokenPilotProductCommandResult {
  return payload ? { text, payload } : { text };
}

export async function writeUpdatedConfig(
  bridge: TokenPilotProductSurfaceHostBridge,
  currentConfig: Record<string, unknown>,
  mutate: (nextConfig: Record<string, unknown>) => string,
): Promise<TokenPilotProductCommandResult> {
  const nextConfig = structuredClone(currentConfig);
  const message = mutate(nextConfig);
  await bridge.writeConfig(nextConfig);
  return { text: message };
}
