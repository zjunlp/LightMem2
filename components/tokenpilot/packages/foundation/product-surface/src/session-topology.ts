import type { ProductSurfaceSessionOverviewItem } from "./presentation.js";

export type ProductSurfaceBaseSessionTopology = {
  sessionId: string;
  latestResponseId?: string;
  previousResponseId?: string;
  responseChain: string[];
  latestModel?: string;
  workspaceHint?: string;
  updatedAt?: string;
  turnCount: number;
};

export function normalizeSessionTopologyValue(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

export function buildSessionResponseChain<TBinding>(
  bindings: TBinding[],
  getResponseId: (binding: TBinding) => unknown,
): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const binding of bindings) {
    const responseId = normalizeSessionTopologyValue(getResponseId(binding));
    if (!responseId || seen.has(responseId)) continue;
    seen.add(responseId);
    chain.push(responseId);
  }
  return chain;
}

export function resolveBaseSessionTopology<TSnapshot, TBinding, TExtra extends object = {}>(params: {
  sessionId: string;
  snapshot?: TSnapshot | null;
  bindings: TBinding[];
  getSnapshotLatestResponseId: (snapshot: TSnapshot | null | undefined) => unknown;
  getBindingResponseId: (binding: TBinding | undefined) => unknown;
  getSnapshotPreviousResponseId: (snapshot: TSnapshot | null | undefined) => unknown;
  getBindingPreviousResponseId: (binding: TBinding | undefined) => unknown;
  getSnapshotModel: (snapshot: TSnapshot | null | undefined) => unknown;
  getBindingModel: (binding: TBinding | undefined) => unknown;
  getSnapshotWorkspaceHint: (snapshot: TSnapshot | null | undefined) => unknown;
  getSnapshotUpdatedAt: (snapshot: TSnapshot | null | undefined) => unknown;
  getBindingUpdatedAt: (binding: TBinding | undefined) => unknown;
  buildExtra?: (snapshot: TSnapshot | null | undefined, latestBinding: TBinding | undefined) => TExtra;
}): ProductSurfaceBaseSessionTopology & TExtra {
  const latestBinding = params.bindings[0];
  return {
    sessionId: params.sessionId,
    latestResponseId:
      normalizeSessionTopologyValue(params.getSnapshotLatestResponseId(params.snapshot))
      ?? normalizeSessionTopologyValue(params.getBindingResponseId(latestBinding)),
    previousResponseId:
      normalizeSessionTopologyValue(params.getSnapshotPreviousResponseId(params.snapshot))
      ?? normalizeSessionTopologyValue(params.getBindingPreviousResponseId(latestBinding)),
    responseChain: buildSessionResponseChain(params.bindings, params.getBindingResponseId),
    latestModel:
      normalizeSessionTopologyValue(params.getSnapshotModel(params.snapshot))
      ?? normalizeSessionTopologyValue(params.getBindingModel(latestBinding)),
    workspaceHint: normalizeSessionTopologyValue(params.getSnapshotWorkspaceHint(params.snapshot)),
    updatedAt:
      normalizeSessionTopologyValue(params.getSnapshotUpdatedAt(params.snapshot))
      ?? normalizeSessionTopologyValue(params.getBindingUpdatedAt(latestBinding)),
    turnCount: params.bindings.length,
    ...(params.buildExtra?.(params.snapshot, latestBinding) ?? {} as TExtra),
  };
}

export function buildBaseSessionOverview(
  topology: ProductSurfaceBaseSessionTopology,
  extraItems: ProductSurfaceSessionOverviewItem[] = [],
): ProductSurfaceSessionOverviewItem[] {
  const overview: ProductSurfaceSessionOverviewItem[] = [
    { label: "Session", value: topology.sessionId },
    { label: "Turns", value: topology.turnCount },
    { label: "Model", value: topology.latestModel ?? "unknown" },
    { label: "Workspace", value: topology.workspaceHint ?? "unknown" },
    { label: "Latest response", value: topology.latestResponseId ?? "unknown" },
    { label: "Previous response", value: topology.previousResponseId ?? "unknown" },
    ...extraItems,
  ];

  if (topology.responseChain.length > 0) {
    overview.push({ label: "Response chain", value: topology.responseChain.join(" -> ") });
  }

  return overview;
}
