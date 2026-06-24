import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CodexProviderConfig = {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  wireApi?: "responses" | "chat";
  requiresOpenAIAuth?: boolean;
};

export type TokenPilotCodexConfig = {
  enabled: boolean;
  logLevel: "info" | "debug";
  stateDir: string;
  proxyPort: number;
  providerName: string;
  proxyBaseUrl?: string;
  proxyApiKey?: string;
  upstreamProvider?: string;
  upstream?: CodexProviderConfig;
  proxyMode: {
    pureForward: boolean;
  };
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

export function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function defaultCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

export function defaultTokenPilotConfigPath(): string {
  return join(homedir(), ".codex", "tokenpilot.json");
}

export function defaultStateDir(): string {
  return join(homedir(), ".codex", "tokenpilot-state", "tokenpilot");
}

export function defaultHooksConfigPath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

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

function sanitizeCodexReductionPassOptions(raw: unknown): Record<string, Record<string, unknown>> {
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
      output[key] = value as Record<string, unknown>;
    }
  }
  return output;
}

export function normalizeTokenPilotCodexConfig(raw: unknown): TokenPilotCodexConfig {
  const obj = asRecord(raw);
  const proxyMode = asRecord(obj.proxyMode);
  const hooks = asRecord(obj.hooks);
  const modules = asRecord(obj.modules);
  const reduction = asRecord(obj.reduction);
  const passes = asRecord(reduction.passes);
  const upstream = asRecord(obj.upstream);
  const upstreamBaseUrl = stringValue(upstream.baseUrl);

  return {
    enabled: boolValue(obj.enabled, true),
    logLevel: obj.logLevel === "debug" ? "debug" : "info",
    stateDir: expandHomePath(stringValue(obj.stateDir) ?? defaultStateDir()),
    proxyPort: numberValue(obj.proxyPort, 17667, 1025, 65535),
    providerName: stringValue(obj.providerName) ?? "tokenpilot",
    proxyBaseUrl: stringValue(obj.proxyBaseUrl),
    proxyApiKey: stringValue(obj.proxyApiKey),
    upstreamProvider: stringValue(obj.upstreamProvider) ?? "OpenAI",
    upstream: upstreamBaseUrl
      ? {
        name: stringValue(upstream.name),
        baseUrl: upstreamBaseUrl.replace(/\/+$/, ""),
        apiKey: stringValue(upstream.apiKey),
        wireApi: upstream.wireApi === "chat" ? "chat" : "responses",
        requiresOpenAIAuth: boolValue(upstream.requiresOpenAIAuth, true),
      }
      : undefined,
    proxyMode: {
      pureForward: boolValue(proxyMode.pureForward, false),
    },
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
      passOptions: sanitizeCodexReductionPassOptions(reduction.passOptions),
    },
  };
}

export async function loadTokenPilotCodexConfig(configPath = defaultTokenPilotConfigPath()): Promise<TokenPilotCodexConfig> {
  if (!existsSync(configPath)) {
    return normalizeTokenPilotCodexConfig({});
  }
  const text = await readFile(configPath, "utf8");
  return normalizeTokenPilotCodexConfig(JSON.parse(text));
}

export async function writeTokenPilotCodexConfig(
  config: TokenPilotCodexConfig,
  configPath = defaultTokenPilotConfigPath(),
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
}

type TomlSection = {
  name: string;
  values: Record<string, string>;
};

function parseTomlStringValue(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed ? trimmed : undefined;
}

export async function readCodexProviderFromToml(
  providerName: string,
  configPath = defaultCodexConfigPath(),
): Promise<CodexProviderConfig | undefined> {
  if (!existsSync(configPath)) return undefined;
  const text = await readFile(configPath, "utf8");
  const sections: TomlSection[] = [];
  let current: TomlSection | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      current = { name: sectionMatch[1], values: {} };
      sections.push(current);
      continue;
    }
    if (!current || trimmed.startsWith("#")) continue;
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!assignment) continue;
    current.values[assignment[1]] = assignment[2].replace(/\s+#.*$/, "").trim();
  }
  const section = sections.find((item) => item.name === `model_providers.${providerName}`);
  if (!section) return undefined;
  const baseUrl = parseTomlStringValue(section.values.base_url);
  if (!baseUrl) return undefined;
  const wireApi = parseTomlStringValue(section.values.wire_api);
  const apiKey = parseTomlStringValue(section.values.api_key)
    ?? parseTomlStringValue(section.values.apiKey);
  return {
    name: parseTomlStringValue(section.values.name),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    wireApi: wireApi === "chat" ? "chat" : "responses",
    requiresOpenAIAuth: section.values.requires_openai_auth !== "false",
  };
}

export async function resolveUpstreamProvider(
  config: TokenPilotCodexConfig,
  codexConfigPath = defaultCodexConfigPath(),
): Promise<CodexProviderConfig> {
  if (config.proxyBaseUrl) {
    return {
      name: "explicit",
      baseUrl: config.proxyBaseUrl.replace(/\/+$/, ""),
      apiKey: config.proxyApiKey,
      wireApi: "responses",
      requiresOpenAIAuth: true,
    };
  }
  if (config.upstream?.baseUrl) return config.upstream;
  const providerName = config.upstreamProvider ?? "OpenAI";
  const provider = await readCodexProviderFromToml(providerName, codexConfigPath);
  if (!provider) {
    throw new Error(`Codex provider ${providerName} was not found in ${codexConfigPath}`);
  }
  return provider;
}
