function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

export function readCachedInputTokens(usage: unknown): number {
  const record = asRecord(usage);
  if (!record) return 0;

  const direct = finiteNumber(record.cache_read_input_tokens);
  if (typeof direct === "number" && direct >= 0) return direct;

  const topLevel = finiteNumber(record.cached_tokens);
  if (typeof topLevel === "number" && topLevel >= 0) return topLevel;

  const inputDetails = asRecord(record.input_tokens_details);
  const promptDetails = asRecord(record.prompt_tokens_details);
  const nested =
    finiteNumber(inputDetails?.cached_tokens)
    ?? finiteNumber(promptDetails?.cached_tokens);
  if (typeof nested === "number" && nested >= 0) return nested;

  return 0;
}

export function hasCachedInputTokens(usage: unknown): boolean {
  return readCachedInputTokens(usage) > 0;
}

