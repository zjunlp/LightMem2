/* eslint-disable @typescript-eslint/no-explicit-any */
import { createPromptingDistiller } from "@lightmem2/memory";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function jsonTextFromChatPayload(payload: any): string {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const first = choices[0];
  const content = first?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const texts = content
      .map((part: any) => (typeof part?.text === "string" ? part.text.trim() : ""))
      .filter((text: string) => text.length > 0);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

export function embeddingProviderFromConfig(cfg: any):
  | {
      baseUrl: string;
      apiKey: string;
      model: string;
      queryInstruction?: string;
    }
  | undefined {
  const embedding = cfg?.memory?.embedding;
  if (!embedding || embedding.enabled !== true) return undefined;
  const baseUrl = String(embedding.baseUrl ?? "").trim();
  const apiKey = String(embedding.apiKey ?? "").trim();
  const model = String(embedding.model ?? "").trim();
  if (!baseUrl || !apiKey || !model) return undefined;
  return {
    baseUrl,
    apiKey,
    model,
    queryInstruction: typeof embedding.queryInstruction === "string" ? embedding.queryInstruction.trim() : undefined,
  };
}

export function distillProviderFromConfig(cfg: any):
  | {
      baseUrl: string;
      apiKey: string;
      model: string;
      requestTimeoutMs?: number;
    }
  | undefined {
  const provider = cfg?.memory?.distillProvider;
  if (!provider) return undefined;
  const baseUrl = String(provider.baseUrl ?? "").trim();
  const apiKey = String(provider.apiKey ?? "").trim();
  const model = String(provider.model ?? "").trim();
  if (!baseUrl || !apiKey || !model) return undefined;
  return {
    baseUrl,
    apiKey,
    model,
    requestTimeoutMs: typeof provider.requestTimeoutMs === "number" ? provider.requestTimeoutMs : undefined,
  };
}

export function createConfiguredDistiller(cfg: any) {
  const provider = distillProviderFromConfig(cfg);
  if (!provider) return undefined;
  const kind = String(cfg?.memory?.distillerType ?? "prompting").trim();
  if (kind === "prompting") return createPromptingDistiller(provider);
  if (kind === "autoskill") throw new Error("procedural_memory_distiller_not_implemented:autoskill");
  if (kind === "ctx2skill") throw new Error("procedural_memory_distiller_not_implemented:ctx2skill");
  throw new Error(`procedural_memory_distiller_unknown:${kind}`);
}

export async function adaptProceduralMemoryInjection(params: {
  cfg: any;
  objective: string;
  rawInjectionText: string;
}): Promise<{ useful: boolean; adaptedHint: string; reason: string }> {
  const provider = distillProviderFromConfig(params.cfg);
  if (!provider || !params.rawInjectionText.trim()) {
    return {
      useful: false,
      adaptedHint: "",
      reason: provider ? "empty_candidate" : "adapter_missing",
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1000, typeof provider.requestTimeoutMs === "number" ? provider.requestTimeoutMs : 60_000),
  );
  try {
    const systemPrompt = [
      "You adapt procedural memory into a minimal task-specific factual hint for an agent.",
      "Decide whether any part of the candidate memory is genuinely useful for the current task.",
      "Keep only the smallest useful subset.",
      "Prefer transcript-grounded specifics over generic advice.",
      "Favor concise retained facts, decisions, owners, deadlines, named entities, quotes, constraints, and concrete checks.",
      "Drop generic methodology, broad writing advice, stylistic guidance, and any detail that is weakly related or likely to encourage fabrication.",
      "Return only JSON with exactly this schema:",
      "{\"useful\":boolean,\"retained_facts\":string[],\"reason\":string}",
      "If useful is true, retained_facts must contain 1 to 3 short bullets.",
      "Each bullet must be under 18 words.",
      "Keep the total output under 55 words.",
      "Only keep details that are directly helpful for the current task.",
      "Do not add new facts.",
      "Do not repeat boilerplate.",
      "If the memory is not useful, set useful=false and retained_facts to an empty array.",
    ].join(" ");
    const userPayload = JSON.stringify({
      objective: params.objective,
      candidate_memory: params.rawInjectionText,
    });
    const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPayload },
        ],
        response_format: {
          type: "json_object",
        },
        temperature: 0,
      }),
    });
    if (!response.ok) {
      throw new Error(`memory_adapter_failed:${response.status}:${await response.text()}`);
    }
    const payload = await response.json();
    const raw = JSON.parse(jsonTextFromChatPayload(payload) || "{}") as {
      useful?: boolean;
      retained_facts?: string[];
      reason?: string;
    };
    const retainedFacts = Array.isArray(raw?.retained_facts)
      ? raw.retained_facts
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .slice(0, 3)
      : [];
    const adaptedHint = retainedFacts.map((fact) => `- ${fact}`).join("\n").trim();
    const useful = adaptedHint.length > 0 && raw?.useful !== false;
    return {
      useful,
      adaptedHint: useful ? adaptedHint : "",
      reason: typeof raw?.reason === "string" && raw.reason.trim() ? raw.reason.trim() : "adapter_decision",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      useful: false,
      adaptedHint: "",
      reason: `adapter_failed:${reason}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
