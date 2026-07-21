import { handleVisual as handleSharedVisual } from "@tokenpilot/product-surface";
import { resolveStateDir } from "./host-config-adapter.js";

export async function handleVisual(currentConfig: Record<string, unknown>): Promise<{ text: string }> {
  return handleSharedVisual(currentConfig, resolveStateDir);
}
