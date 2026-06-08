export const TOKENPILOT_CONFIG_ROOT = ["plugins", "entries", "tokenpilot", "config"] as const;
export const TOKENPILOT_ENTRY_ROOT = ["plugins", "entries", "tokenpilot"] as const;

export const REDUCTION_PASS_PATHS: Record<string, string[]> = {
  repeatedReadDedup: ["reduction", "passes", "repeatedReadDedup"],
  toolPayloadTrim: ["reduction", "passes", "toolPayloadTrim"],
  htmlSlimming: ["reduction", "passes", "htmlSlimming"],
  execOutputTruncation: ["reduction", "passes", "execOutputTruncation"],
  agentsStartupOptimization: ["reduction", "passes", "agentsStartupOptimization"],
  memoryFaultRecovery: ["reduction", "passes", "memoryFaultRecovery"],
  formatSlimming: ["reduction", "passOptions", "formatSlimming", "enabled"],
  formatCleaning: ["reduction", "passOptions", "formatCleaning", "enabled"],
  pathTruncation: ["reduction", "passOptions", "pathTruncation", "enabled"],
  imageDownsample: ["reduction", "passOptions", "imageDownsample", "enabled"],
  lineNumberStrip: ["reduction", "passOptions", "lineNumberStrip", "enabled"],
};

export const REDUCTION_PRESETS: Record<
  string,
  {
    triggerMinChars: number;
    maxToolChars: number;
    passToggles: Record<string, boolean>;
  }
> = {
  light: {
    triggerMinChars: 4000,
    maxToolChars: 1800,
    passToggles: {
      repeatedReadDedup: true,
      toolPayloadTrim: true,
      htmlSlimming: false,
      execOutputTruncation: false,
      agentsStartupOptimization: true,
      memoryFaultRecovery: false,
      formatSlimming: false,
      formatCleaning: false,
      pathTruncation: false,
      imageDownsample: false,
      lineNumberStrip: false,
    },
  },
  balanced: {
    triggerMinChars: 2200,
    maxToolChars: 1200,
    passToggles: {
      repeatedReadDedup: true,
      toolPayloadTrim: true,
      htmlSlimming: true,
      execOutputTruncation: true,
      agentsStartupOptimization: true,
      memoryFaultRecovery: false,
      formatSlimming: true,
      formatCleaning: true,
      pathTruncation: true,
      imageDownsample: true,
      lineNumberStrip: true,
    },
  },
  aggressive: {
    triggerMinChars: 1400,
    maxToolChars: 900,
    passToggles: {
      repeatedReadDedup: true,
      toolPayloadTrim: true,
      htmlSlimming: true,
      execOutputTruncation: true,
      agentsStartupOptimization: true,
      memoryFaultRecovery: false,
      formatSlimming: true,
      formatCleaning: true,
      pathTruncation: true,
      imageDownsample: true,
      lineNumberStrip: true,
    },
  },
};

export function parseCommandAction(raw: string): { action: string; rest: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { action: "", rest: "" };
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) return { action: trimmed.toLowerCase(), rest: "" };
  return {
    action: trimmed.slice(0, firstSpace).trim().toLowerCase(),
    rest: trimmed.slice(firstSpace + 1).trim(),
  };
}

export function splitArgs(raw: string): string[] {
  return raw.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

export function getNestedValue(target: unknown, path: readonly string[]): unknown {
  let current: unknown = target;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setNestedValue(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (path.length === 0) throw new Error("Path cannot be empty.");
  let current: Record<string, unknown> = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const existing = current[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

export function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function parseBooleanWord(raw: string): boolean | undefined {
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
    case "enable":
    case "enabled":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
    case "disable":
    case "disabled":
      return false;
    default:
      return undefined;
  }
}

export function parseNumberWord(raw: string): number | undefined {
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseStringValue(raw: string): string {
  return raw.trim();
}

export function formatDisplayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "(unset)";
  return JSON.stringify(value, null, 2);
}

export function formatInt(value: number | undefined): string {
  if (!Number.isFinite(value ?? Number.NaN)) return "0";
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value ?? 0)));
}

export function countModeLabel(mode: unknown): "tokens" | "chars" {
  return mode === "chars" ? "chars" : "tokens";
}

export function formatOnOff(value: unknown): string {
  return value === true ? "on" : "off";
}

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

export function applyReductionPreset(config: Record<string, unknown>, presetName: string): void {
  const preset = REDUCTION_PRESETS[presetName];
  if (!preset) return;
  const pluginCfg = ensurePluginConfig(config);
  setNestedValue(pluginCfg, ["modules", "reduction"], true);
  setNestedValue(pluginCfg, ["reduction", "engine"], "layered");
  setNestedValue(pluginCfg, ["reduction", "triggerMinChars"], preset.triggerMinChars);
  setNestedValue(pluginCfg, ["reduction", "maxToolChars"], preset.maxToolChars);
  for (const [passName, enabled] of Object.entries(preset.passToggles)) {
    const passPath = REDUCTION_PASS_PATHS[passName];
    if (passPath) setNestedValue(pluginCfg, passPath, enabled);
  }
}

export async function writeUpdatedConfig(
  api: any,
  currentConfig: Record<string, unknown>,
  mutate: (nextConfig: Record<string, unknown>) => string,
): Promise<{ text: string }> {
  const nextConfig = structuredClone(currentConfig);
  const message = mutate(nextConfig);
  await api.runtime.config.writeConfigFile(nextConfig);
  return { text: message };
}
