import type { ProductSurfaceConfigAdapter } from "@lightmem2/host-adapter";

export function ensureClaudeCodePluginConfig(config: Record<string, unknown>): Record<string, unknown> {
  return config;
}

export function ensureClaudeCodePluginEntry(config: Record<string, unknown>): Record<string, unknown> {
  return config;
}

export function claudeCodePluginConfigRecord(config: Record<string, unknown>): Record<string, unknown> | undefined {
  return config;
}

export function claudeCodePluginEntryRecord(config: Record<string, unknown>): Record<string, unknown> | undefined {
  return config;
}

export function resolveClaudeCodeStateDir(config: Record<string, unknown>): string | undefined {
  const stateDir = config.stateDir;
  return typeof stateDir === "string" && stateDir.trim().length > 0 ? stateDir.trim() : undefined;
}

export const claudeCodeProductSurfaceConfigAdapter: ProductSurfaceConfigAdapter = {
  pluginConfigRecord: claudeCodePluginConfigRecord,
  pluginEntryRecord: claudeCodePluginEntryRecord,
  ensurePluginConfig: ensureClaudeCodePluginConfig,
  ensurePluginEntry: ensureClaudeCodePluginEntry,
  resolveStateDir: resolveClaudeCodeStateDir,
};
