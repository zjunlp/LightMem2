import type { EmbeddingProviderConfig } from "./types.js";

type OpenAiEmbeddingResponse = {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function withQueryInstruction(input: string, instruction?: string): string {
  const task = instruction?.trim() || "Retrieve procedural skills relevant to the current coding task";
  return `Instruct: ${task}\nQuery: ${input}`;
}

export async function embedTextsWithOpenAiCompatibleApi(params: {
  provider: EmbeddingProviderConfig;
  inputs: string[];
  isQuery?: boolean;
}): Promise<number[][]> {
  const provider = params.provider;
  const payload = {
    model: provider.model,
    input: params.inputs.map((input) => (params.isQuery ? withQueryInstruction(input, provider.queryInstruction) : input)),
  };
  const response = await fetch(`${trimTrailingSlash(provider.baseUrl)}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`embedding request failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as OpenAiEmbeddingResponse;
  const embeddings = Array.isArray(data.data)
    ? data.data
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((item) => (Array.isArray(item.embedding) ? item.embedding : []))
    : [];
  if (embeddings.length !== params.inputs.length) {
    throw new Error(`embedding response size mismatch: expected ${params.inputs.length}, got ${embeddings.length}`);
  }
  return embeddings;
}
