import type { TokenPilotProductSurfaceConfigAdapter } from "@tokenpilot/host-adapter";

export const REDUCTION_PASS_PATHS: Record<string, string[]> = {
  readStateCompaction: ["reduction", "passes", "readStateCompaction"],
  toolPayloadTrim: ["reduction", "passes", "toolPayloadTrim"],
  htmlSlimming: ["reduction", "passes", "htmlSlimming"],
  execOutputTruncation: ["reduction", "passes", "execOutputTruncation"],
  agentsStartupOptimization: ["reduction", "passes", "agentsStartupOptimization"],
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
      readStateCompaction: true,
      toolPayloadTrim: true,
      htmlSlimming: false,
      execOutputTruncation: false,
      agentsStartupOptimization: true,
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
      readStateCompaction: true,
      toolPayloadTrim: true,
      htmlSlimming: true,
      execOutputTruncation: true,
      agentsStartupOptimization: true,
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
      readStateCompaction: true,
      toolPayloadTrim: true,
      htmlSlimming: true,
      execOutputTruncation: true,
      agentsStartupOptimization: true,
      formatSlimming: true,
      formatCleaning: true,
      pathTruncation: true,
      imageDownsample: true,
      lineNumberStrip: true,
    },
  },
};

export const RUNTIME_MODE_PRESETS: Record<
  string,
  {
    reductionPreset: "light" | "balanced" | "aggressive";
    evictionEnabled: boolean;
    taskStateEstimatorEnabled: boolean;
  }
> = {
  conservative: {
    reductionPreset: "light",
    evictionEnabled: false,
    taskStateEstimatorEnabled: false,
  },
  normal: {
    reductionPreset: "balanced",
    evictionEnabled: false,
    taskStateEstimatorEnabled: false,
  },
  aggressive: {
    reductionPreset: "aggressive",
    evictionEnabled: true,
    taskStateEstimatorEnabled: true,
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

export function countModeDescription(mode: unknown): string {
  return mode === "chars" ? "chars fallback" : "precise OpenAI tokens";
}

export function formatOnOff(value: unknown): string {
  return value === true ? "on" : "off";
}

export function applyReductionPreset(
  config: Record<string, unknown>,
  presetName: string,
  adapter: TokenPilotProductSurfaceConfigAdapter,
): void {
  const preset = REDUCTION_PRESETS[presetName];
  if (!preset) return;
  const pluginCfg = adapter.ensurePluginConfig(config);
  setNestedValue(pluginCfg, ["modules", "reduction"], true);
  setNestedValue(pluginCfg, ["reduction", "engine"], "layered");
  setNestedValue(pluginCfg, ["reduction", "triggerMinChars"], preset.triggerMinChars);
  setNestedValue(pluginCfg, ["reduction", "maxToolChars"], preset.maxToolChars);
  for (const [passName, enabled] of Object.entries(preset.passToggles)) {
    const passPath = REDUCTION_PASS_PATHS[passName];
    if (passPath) setNestedValue(pluginCfg, passPath, enabled);
  }
}

export function applyRuntimeMode(
  config: Record<string, unknown>,
  modeName: string,
  adapter: TokenPilotProductSurfaceConfigAdapter,
): void {
  const preset = RUNTIME_MODE_PRESETS[modeName];
  if (!preset) return;

  const entry = adapter.ensurePluginEntry(config);
  const pluginCfg = adapter.ensurePluginConfig(config);
  entry.enabled = true;
  pluginCfg.enabled = true;

  adapter.setRuntimeHostDefaults?.(config);

  setNestedValue(pluginCfg, ["modules", "stabilizer"], true);
  setNestedValue(pluginCfg, ["modules", "policy"], true);
  setNestedValue(pluginCfg, ["modules", "reduction"], true);
  setNestedValue(pluginCfg, ["modules", "eviction"], preset.evictionEnabled);
  setNestedValue(pluginCfg, ["eviction", "enabled"], preset.evictionEnabled);
  setNestedValue(pluginCfg, ["taskStateEstimator", "enabled"], preset.taskStateEstimatorEnabled);
  applyReductionPreset(config, preset.reductionPreset, adapter);
}
