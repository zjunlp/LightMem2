import { handleVisual as handleSharedVisual } from "@lightmem2/product-surface";
import { resolveStateDir } from "./host-config-adapter.js";

export async function handleVisual(currentConfig: Record<string, unknown>): Promise<{ text: string }> {
  return handleSharedVisual(currentConfig, resolveStateDir);
}
