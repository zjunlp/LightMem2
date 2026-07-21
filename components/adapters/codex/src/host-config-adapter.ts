import type { TokenPilotProductSurfaceConfigAdapter } from "@tokenpilot/host-adapter";

export function ensureCodexPluginConfig(config: Record<string, unknown>): Record<string, unknown> {
  return config;
}

export function ensureCodexPluginEntry(config: Record<string, unknown>): Record<string, unknown> {
  return config;
}

export function codexPluginConfigRecord(config: Record<string, unknown>): Record<string, unknown> | undefined {
  return config;
}

export function codexPluginEntryRecord(config: Record<string, unknown>): Record<string, unknown> | undefined {
  return config;
}

export function resolveCodexStateDir(config: Record<string, unknown>): string | undefined {
  const stateDir = config.stateDir;
  return typeof stateDir === "string" && stateDir.trim().length > 0 ? stateDir.trim() : undefined;
}

export const codexProductSurfaceConfigAdapter: TokenPilotProductSurfaceConfigAdapter = {
  pluginConfigRecord: codexPluginConfigRecord,
  pluginEntryRecord: codexPluginEntryRecord,
  ensurePluginConfig: ensureCodexPluginConfig,
  ensurePluginEntry: ensureCodexPluginEntry,
  resolveStateDir: resolveCodexStateDir,
};
