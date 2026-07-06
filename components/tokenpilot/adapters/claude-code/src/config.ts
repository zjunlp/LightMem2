import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CLAUDE_TOOL_SEARCH_ENV = "ENABLE_TOOL_SEARCH";
export const CLAUDE_TOOL_SEARCH_DEFAULT = "true";

export type TokenPilotClaudeCodeConfig = {
  enabled: boolean;
  logLevel: "info" | "debug";
  stateDir: string;
  proxyPort: number;
  proxyBaseUrl?: string;
  proxyApiKey?: string;
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
  upstreamModel?: string;
  visibleModels: string[];
  hooks: {
    dynamicContextTarget: "developer" | "user";
  };
  modules: {
    stabilizer: boolean;
    reduction: boolean;
  };
  reduction: {
    triggerMinChars: number;
    maxToolChars: number;
    passes: {
      readStateCompaction: boolean;
      toolPayloadTrim: boolean;
      htmlSlimming: boolean;
      execOutputTruncation: boolean;
      agentsStartupOptimization: boolean;
    };
    passOptions: Record<string, Record<string, unknown>>;
  };
};

type NormalizeClaudeCodeConfigOptions = {
  configPath?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(next)));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const normalized = stringValue(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function sanitizeClaudeReductionPassOptions(raw: unknown): Record<string, Record<string, unknown>> {
  const input = asRecord(raw);
  const output: Record<string, Record<string, unknown>> = {};
  for (const key of [
    "readStateCompaction",
    "toolPayloadTrim",
    "htmlSlimming",
    "execOutputTruncation",
    "agentsStartupOptimization",
  ]) {
    const value = asRecord(input[key]);
    if (Object.keys(value).length > 0) {
      output[key] = value;
    }
  }
  return output;
}

export function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function defaultClaudeCodeSettingsPath(): string {
  return process.env.CLAUDE_CODE_SETTINGS_PATH
    ? resolve(process.env.CLAUDE_CODE_SETTINGS_PATH)
    : join(homedir(), ".claude", "settings.json");
}

export function defaultClaudeCodeMcpConfigPath(): string {
  return process.env.CLAUDE_CODE_MCP_CONFIG_PATH
    ? resolve(process.env.CLAUDE_CODE_MCP_CONFIG_PATH)
    : join(homedir(), ".claude", ".claude.json");
}

export function defaultTokenPilotClaudeCodeConfigPath(): string {
  return process.env.TOKENPILOT_CLAUDE_CODE_CONFIG
    ? resolve(process.env.TOKENPILOT_CLAUDE_CODE_CONFIG)
    : join(homedir(), ".claude", "tokenpilot.json");
}

export function defaultClaudeCodeStateDir(configPath = defaultTokenPilotClaudeCodeConfigPath()): string {
  return join(dirname(configPath), "tokenpilot-state", "tokenpilot");
}

export function defaultClaudeUpstreamBaseUrl(): string {
  return "https://api.anthropic.com/v1/messages";
}

export function proxyBaseUrlForPort(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function normalizeTokenPilotClaudeCodeConfig(
  raw: unknown,
  options?: NormalizeClaudeCodeConfigOptions,
): TokenPilotClaudeCodeConfig {
  const obj = asRecord(raw);
  const hooks = asRecord(obj.hooks);
  const modules = asRecord(obj.modules);
  const reduction = asRecord(obj.reduction);
  const passes = asRecord(reduction.passes);
  const configPath = options?.configPath ?? defaultTokenPilotClaudeCodeConfigPath();
  return {
    enabled: boolValue(obj.enabled, true),
    logLevel: obj.logLevel === "debug" ? "debug" : "info",
    stateDir: expandHomePath(stringValue(obj.stateDir) ?? defaultClaudeCodeStateDir(configPath)),
    proxyPort: numberValue(obj.proxyPort, 17668, 1025, 65535),
    proxyBaseUrl: stringValue(obj.proxyBaseUrl),
    proxyApiKey: stringValue(obj.proxyApiKey),
    upstreamBaseUrl: (stringValue(obj.upstreamBaseUrl) ?? defaultClaudeUpstreamBaseUrl()).replace(/\/+$/, ""),
    upstreamApiKey: stringValue(obj.upstreamApiKey),
    upstreamModel: stringValue(obj.upstreamModel),
    visibleModels: stringArrayValue(obj.visibleModels),
    hooks: {
      dynamicContextTarget: hooks.dynamicContextTarget === "user" ? "user" : "developer",
    },
    modules: {
      stabilizer: boolValue(modules.stabilizer, true),
      reduction: boolValue(modules.reduction, true),
    },
    reduction: {
      triggerMinChars: numberValue(reduction.triggerMinChars, 2200, 256, 1_000_000),
      maxToolChars: numberValue(reduction.maxToolChars, 1200, 256, 1_000_000),
      passes: {
        readStateCompaction: boolValue(passes.readStateCompaction, true),
        toolPayloadTrim: boolValue(passes.toolPayloadTrim, true),
        htmlSlimming: boolValue(passes.htmlSlimming, true),
        execOutputTruncation: boolValue(passes.execOutputTruncation, true),
        agentsStartupOptimization: boolValue(passes.agentsStartupOptimization, true),
      },
      passOptions: sanitizeClaudeReductionPassOptions(reduction.passOptions),
    },
  };
}

export async function loadTokenPilotClaudeCodeConfig(
  configPath = defaultTokenPilotClaudeCodeConfigPath(),
): Promise<TokenPilotClaudeCodeConfig> {
  if (!existsSync(configPath)) {
    return normalizeTokenPilotClaudeCodeConfig({}, { configPath });
  }
  const text = await readFile(configPath, "utf8");
  return normalizeTokenPilotClaudeCodeConfig(JSON.parse(text), { configPath });
}

export async function writeTokenPilotClaudeCodeConfig(
  config: TokenPilotClaudeCodeConfig,
  configPath = defaultTokenPilotClaudeCodeConfigPath(),
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
}
