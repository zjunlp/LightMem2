import type { StabilizerRequestEnvelope } from "./contracts.js";

function stableSortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stableSortJsonValue(child)]),
  );
}

function toolSortKey(tool: unknown): string {
  if (!tool || typeof tool !== "object") return JSON.stringify(tool);
  const record = tool as Record<string, unknown>;
  const toolType = typeof record.type === "string" ? record.type : "";
  const functionRecord =
    record.function && typeof record.function === "object" && !Array.isArray(record.function)
      ? record.function as Record<string, unknown>
      : undefined;
  const name =
    typeof functionRecord?.name === "string"
      ? functionRecord.name
      : typeof record.name === "string"
        ? record.name
        : "";
  return JSON.stringify({
    toolType,
    name,
    tool: stableSortJsonValue(tool),
  });
}

export function canonicalizeTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  return tools
    .map((tool) => stableSortJsonValue(tool))
    .sort((a, b) => toolSortKey(a).localeCompare(toolSortKey(b)));
}

export function canonicalizeEnvelopeTools<TEnvelope extends StabilizerRequestEnvelope>(
  envelope: TEnvelope,
): TEnvelope {
  if (!Array.isArray(envelope.tools) || envelope.tools.length === 0) return envelope;
  const canonicalTools = canonicalizeTools(envelope.tools);
  const before = JSON.stringify(envelope.tools);
  const after = JSON.stringify(canonicalTools);
  if (before === after) return envelope;
  return {
    ...envelope,
    tools: canonicalTools,
  } as TEnvelope;
}
