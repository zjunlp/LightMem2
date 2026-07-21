import {
  type TokenPilotProductSurfaceConfigAdapter,
} from "@tokenpilot/host-adapter";
import {
  getNestedValue,
  setNestedValue,
  toRecord,
} from "@tokenpilot/product-surface";

export const TOKENPILOT_CONFIG_ROOT = ["plugins", "entries", "tokenpilot", "config"] as const;
export const TOKENPILOT_ENTRY_ROOT = ["plugins", "entries", "tokenpilot"] as const;
export const CONTEXT_ENGINE_SLOT_ROOT = ["plugins", "slots", "contextEngine"] as const;

export function ensurePluginConfig(config: Record<string, unknown>): Record<string, unknown> {
  let current: Record<string, unknown> = config;
  for (const segment of TOKENPILOT_CONFIG_ROOT) {
    const existing = current[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  return current;
}

export function ensurePluginEntry(config: Record<string, unknown>): Record<string, unknown> {
  let current: Record<string, unknown> = config;
  for (const segment of TOKENPILOT_ENTRY_ROOT) {
    const existing = current[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  return current;
}

export function pluginConfigRecord(config: Record<string, unknown>): Record<string, unknown> | undefined {
  return toRecord(getNestedValue(config, TOKENPILOT_CONFIG_ROOT));
}

export function pluginEntryRecord(config: Record<string, unknown>): Record<string, unknown> | undefined {
  return toRecord(getNestedValue(config, TOKENPILOT_ENTRY_ROOT));
}

export function resolveStateDir(config: Record<string, unknown>): string | undefined {
  const pluginCfg = pluginConfigRecord(config);
  const stateDir = getNestedValue(pluginCfg, ["stateDir"]);
  return typeof stateDir === "string" && stateDir.trim().length > 0 ? stateDir.trim() : undefined;
}

export const openClawProductSurfaceConfigAdapter: TokenPilotProductSurfaceConfigAdapter = {
  pluginConfigRecord,
  pluginEntryRecord,
  ensurePluginConfig,
  ensurePluginEntry,
  resolveStateDir,
  setRuntimeHostDefaults(config) {
    setNestedValue(config, CONTEXT_ENGINE_SLOT_ROOT, "layered-context");
    const pluginCfg = ensurePluginConfig(config);
    setNestedValue(pluginCfg, ["contextEngine", "enabled"], true);
  },
};
