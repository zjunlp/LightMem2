import type { ApiFamily, RuntimeTurnContext } from "./types.js";

const toLower = (value: unknown): string => String(value ?? "").trim().toLowerCase();

export function resolveApiFamily(ctx: RuntimeTurnContext): ApiFamily {
  if (ctx.apiFamily) return ctx.apiFamily;

  const provider = toLower(ctx.provider);
  const model = toLower(ctx.model);
  const modelApi = toLower((ctx.metadata as Record<string, unknown> | undefined)?.modelApi);
  const providerApi = toLower((ctx.metadata as Record<string, unknown> | undefined)?.providerApi);
  const apiTag = modelApi || providerApi;

  if (apiTag.includes("responses")) return "openai-responses";
  if (apiTag.includes("completions")) return "openai-completions";
  if (apiTag.includes("anthropic") || apiTag.includes("messages")) return "anthropic-messages";

  if (provider.includes("anthropic") || model.includes("claude")) return "anthropic-messages";
  if (provider.includes("openai") || provider.includes("gmn") || provider.includes("bailian")) {
    return "openai-responses";
  }
  return "other";
}
