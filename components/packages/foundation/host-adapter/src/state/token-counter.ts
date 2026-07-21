import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import o200k_base from "js-tiktoken/ranks/o200k_base";

export type TokenPilotPreciseCountMode = "openai_tokens" | "chars";

export type TokenPilotCountResult = {
  count: number;
  mode: TokenPilotPreciseCountMode;
};

type TokenEncodingName = "cl100k_base" | "o200k_base";

const MODEL_PREFIX_ENCODINGS: Array<[prefix: string, encoding: TokenEncodingName]> = [
  ["gpt-5", "o200k_base"],
  ["gpt-4.1", "o200k_base"],
  ["gpt-4o", "o200k_base"],
  ["o1", "o200k_base"],
  ["o3", "o200k_base"],
  ["gpt-4", "cl100k_base"],
  ["gpt-3.5", "cl100k_base"],
];

const encoders = {
  cl100k_base: new Tiktoken(cl100k_base),
  o200k_base: new Tiktoken(o200k_base),
};

function normalizeModelForCounter(model: string): string {
  const trimmed = String(model || "").trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.startsWith("tokenpilot/")) return trimmed.slice("tokenpilot/".length);
  if (trimmed.startsWith("lightmem2/")) return trimmed.slice("lightmem2/".length);
  return trimmed;
}

function resolveEncodingForModel(model: string): TokenEncodingName | null {
  const normalized = normalizeModelForCounter(model);
  for (const [prefix, encoding] of MODEL_PREFIX_ENCODINGS) {
    if (normalized.startsWith(prefix)) return encoding;
  }
  return null;
}

export function countTextWithPreciseTokens(
  model: string,
  text: string,
): TokenPilotCountResult {
  const encoding = resolveEncodingForModel(model);
  if (!encoding) {
    return {
      count: text.length,
      mode: "chars",
    };
  }
  return {
    count: encoders[encoding].encode(String(text ?? "")).length,
    mode: "openai_tokens",
  };
}
