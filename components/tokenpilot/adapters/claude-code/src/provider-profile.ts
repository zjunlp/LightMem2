import type { TokenPilotClaudeCodeConfig } from "./config.js";

export type AnthropicModelListEntry = {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
};

export type AnthropicProviderProfile = {
  id: string;
  matchesUpstreamBaseUrl(baseUrl: string): boolean;
  visibleModelIds(config: TokenPilotClaudeCodeConfig): string[];
  mapVisibleModelToUpstreamModel(config: TokenPilotClaudeCodeConfig, model: string): string;
  rewriteInstalledVisibleModel(value: unknown): string | undefined;
};

function uniqueStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

const DEFAULT_VISIBLE_CLAUDE_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-1",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

const deepSeekAnthropicProfile: AnthropicProviderProfile = {
  id: "deepseek-anthropic",
  matchesUpstreamBaseUrl(baseUrl: string): boolean {
    return /api\.deepseek\.com\/anthropic\/?$/i.test(baseUrl.trim());
  },
  visibleModelIds(): string[] {
    return [...DEFAULT_VISIBLE_CLAUDE_MODELS];
  },
  mapVisibleModelToUpstreamModel(config: TokenPilotClaudeCodeConfig, model: string): string {
    const normalized = model.trim().toLowerCase();
    if (!normalized) {
      return String(config.upstreamModel ?? "").trim() || "deepseek-v4-pro";
    }
    if (normalized.startsWith("deepseek-")) return model.trim();
    if (normalized.startsWith("claude-haiku")) return "deepseek-v4-flash";
    if (normalized.startsWith("claude-sonnet")) {
      return String(config.upstreamModel ?? "").trim() || "deepseek-v4-pro";
    }
    if (normalized.startsWith("claude-opus")) {
      return String(config.upstreamModel ?? "").trim() || "deepseek-v4-pro";
    }
    return model;
  },
  rewriteInstalledVisibleModel(value: unknown): string | undefined {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!normalized.startsWith("deepseek-")) return undefined;
    if (normalized.includes("flash")) return "claude-haiku-4-5";
    return "claude-sonnet-4-6";
  },
};

const defaultAnthropicProfile: AnthropicProviderProfile = {
  id: "default-anthropic",
  matchesUpstreamBaseUrl(): boolean {
    return true;
  },
  visibleModelIds(config: TokenPilotClaudeCodeConfig): string[] {
    const configured = uniqueStrings([
      ...config.visibleModels,
      config.upstreamModel,
    ]);
    return configured.length > 0 ? configured : [...DEFAULT_VISIBLE_CLAUDE_MODELS];
  },
  mapVisibleModelToUpstreamModel(_config: TokenPilotClaudeCodeConfig, model: string): string {
    return model;
  },
  rewriteInstalledVisibleModel(): string | undefined {
    return undefined;
  },
};

const ANTHROPIC_PROVIDER_PROFILES: AnthropicProviderProfile[] = [
  deepSeekAnthropicProfile,
  defaultAnthropicProfile,
];

export function resolveAnthropicProviderProfile(
  configOrBaseUrl: TokenPilotClaudeCodeConfig | string,
): AnthropicProviderProfile {
  const baseUrl = typeof configOrBaseUrl === "string"
    ? configOrBaseUrl
    : configOrBaseUrl.upstreamBaseUrl;
  return ANTHROPIC_PROVIDER_PROFILES.find((profile) => profile.matchesUpstreamBaseUrl(baseUrl)) ?? defaultAnthropicProfile;
}

export function buildAnthropicGatewayModelList(config: TokenPilotClaudeCodeConfig): {
  data: AnthropicModelListEntry[];
  has_more: false;
  first_id: string | null;
  last_id: string | null;
} {
  const profile = resolveAnthropicProviderProfile(config);
  const createdAt = "2026-01-01T00:00:00Z";
  const data = profile.visibleModelIds(config).map((id) => ({
    type: "model" as const,
    id,
    display_name: id,
    created_at: createdAt,
  }));
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

export function mapClaudeVisibleModelToUpstreamModel(
  config: TokenPilotClaudeCodeConfig,
  model: string,
): string {
  return resolveAnthropicProviderProfile(config).mapVisibleModelToUpstreamModel(config, model);
}

export function rewriteInstalledClaudeVisibleModel(
  config: TokenPilotClaudeCodeConfig,
  value: unknown,
): string | undefined {
  return resolveAnthropicProviderProfile(config).rewriteInstalledVisibleModel(value);
}
