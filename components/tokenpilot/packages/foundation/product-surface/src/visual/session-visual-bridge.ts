import { createHash } from "node:crypto";
import {
  prepareBeforeCallWithReductionSummary,
  recordUxEffect,
  type HostPayloadCodec,
  type HostRequestEnvelope,
  type PreparedBeforeCallResult,
  type TokenPilotUxCountMode,
} from "@tokenpilot/host-adapter";
import { extractContentText, rewriteTextForStablePrefix } from "@tokenpilot/stabilizer";
import {
  appendReductionVisualSnapshot,
  appendStabilityVisualSnapshot,
  type ReductionVisualSnapshot,
  type StabilityVisualSnapshot,
} from "./session-visual-data.js";

export type SharedReductionVisualSegment = {
  segmentId: string;
  itemIndex: number;
  field: ReductionVisualSnapshot["field"];
  blockIndex?: number;
  blockKey?: "text" | "content";
  toolName?: string;
  dataPath?: string;
  savedChars: number;
  beforeText: string;
  afterText: string;
  report: ReductionVisualSnapshot["report"];
};

export type BeforeCallOptimizationSummary = {
  countMode?: TokenPilotUxCountMode;
  beforeCount: number;
  afterCount: number;
  savedCount: number;
  details?: {
    requestSavedCount?: number;
    responseSavedCount?: number;
  };
  segments?: SharedReductionVisualSegment[];
  requestId?: string;
};

export function buildVisualRequestId(parts: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export function findFirstUserMessageText(envelope: Pick<HostRequestEnvelope, "messages">): string {
  const messages = Array.isArray(envelope.messages) ? envelope.messages : [];
  const user = messages.find((message) => message?.role === "user");
  return user ? extractContentText(user.content) : "";
}

export function findFirstMessageText(
  envelope: Pick<HostRequestEnvelope, "messages">,
  matcher: (message: HostRequestEnvelope["messages"][number]) => boolean,
): string {
  const messages = Array.isArray(envelope.messages) ? envelope.messages : [];
  const matched = messages.find((message) => matcher(message));
  return matched ? extractContentText(matched.content) : "";
}

export function buildBeforeCallReductionRequestId(params: {
  at?: string;
  sessionId: string;
  model: string;
  preparedEnvelope: Pick<HostRequestEnvelope, "messages" | "metadata">;
}): string {
  const at = params.at ?? new Date().toISOString();
  return buildVisualRequestId([
    at,
    params.sessionId,
    params.model,
    params.preparedEnvelope.metadata?.promptCacheKey ?? "",
    params.preparedEnvelope.metadata?.previousResponseId ?? "",
    Array.isArray(params.preparedEnvelope.messages) ? params.preparedEnvelope.messages.length : -1,
  ]);
}

export function buildStabilityVisualSnapshotFromTexts(params: {
  at?: string;
  sessionId: string;
  model: string;
  upstreamModel: string;
  promptCacheKeyBefore: string;
  promptCacheKeyAfter: string;
  dynamicContextTarget: StabilityVisualSnapshot["dynamicContextTarget"];
  developerBefore: string;
  developerForwarded: string;
  userBefore?: string;
  userForwarded?: string;
  developerCanonical?: string;
  dynamicContextText?: string;
  senderMetadataBlocksBefore?: number;
  senderMetadataBlocksAfter?: number;
  firstTurnCandidate: boolean;
}): StabilityVisualSnapshot {
  const rewrite = rewriteTextForStablePrefix(String(params.developerBefore ?? ""));
  const dynamicContextText = params.dynamicContextText ?? rewrite.dynamicContextText;
  const developerCanonical = params.developerCanonical ?? rewrite.canonicalText;
  const userContentRewrites =
    params.dynamicContextTarget === "user" && dynamicContextText.length > 0
      ? Number(String(params.userForwarded ?? "") !== String(params.userBefore ?? ""))
      : 0;
  return {
    kind: "stability",
    at: params.at ?? new Date().toISOString(),
    sessionId: params.sessionId,
    model: params.model,
    upstreamModel: params.upstreamModel,
    promptCacheKeyBefore: String(params.promptCacheKeyBefore ?? ""),
    promptCacheKeyAfter: String(params.promptCacheKeyAfter ?? ""),
    dynamicContextTarget: params.dynamicContextTarget,
    userContentRewrites,
    senderMetadataBlocksBefore: Number(params.senderMetadataBlocksBefore ?? 0),
    senderMetadataBlocksAfter: Number(params.senderMetadataBlocksAfter ?? 0),
    developerBefore: String(params.developerBefore ?? ""),
    developerCanonical,
    developerForwarded: String(params.developerForwarded ?? ""),
    dynamicContextText,
    firstTurnCandidate: params.firstTurnCandidate,
  };
}

export function buildStabilityVisualSnapshotFromEnvelopes(params: {
  at?: string;
  originalEnvelope: Pick<HostRequestEnvelope, "messages" | "metadata" | "instructions">;
  preparedEnvelope: Pick<HostRequestEnvelope, "messages" | "metadata" | "instructions">;
  sessionId: string;
  model: string;
  upstreamModel: string;
  dynamicContextTarget: StabilityVisualSnapshot["dynamicContextTarget"];
  getDeveloperText: (envelope: Pick<HostRequestEnvelope, "messages" | "metadata" | "instructions">) => string;
  developerCanonical?: string;
  developerForwarded?: string;
  dynamicContextText?: string;
  senderMetadataBlocksBefore?: number;
  senderMetadataBlocksAfter?: number;
  firstTurnCandidate?: boolean;
}): StabilityVisualSnapshot {
  return buildStabilityVisualSnapshotFromTexts({
    at: params.at,
    sessionId: params.sessionId,
    model: params.model,
    upstreamModel: params.upstreamModel,
    promptCacheKeyBefore: String(params.originalEnvelope.metadata?.promptCacheKey ?? ""),
    promptCacheKeyAfter: String(
      params.preparedEnvelope.metadata?.frameworkStablePromptCacheKey
      ?? params.preparedEnvelope.metadata?.promptCacheKey
      ?? "",
    ),
    dynamicContextTarget: params.dynamicContextTarget,
    developerBefore: params.getDeveloperText(params.originalEnvelope),
    developerForwarded: params.developerForwarded ?? params.getDeveloperText(params.preparedEnvelope),
    developerCanonical: params.developerCanonical,
    dynamicContextText: params.dynamicContextText,
    userBefore: findFirstUserMessageText(params.originalEnvelope),
    userForwarded: findFirstUserMessageText(params.preparedEnvelope),
    senderMetadataBlocksBefore: params.senderMetadataBlocksBefore,
    senderMetadataBlocksAfter: params.senderMetadataBlocksAfter,
    firstTurnCandidate:
      params.firstTurnCandidate
      ?? !String(params.originalEnvelope.metadata?.previousResponseId ?? "").trim(),
  });
}

export async function recordBeforeCallVisualState(params: {
  stateDir: string;
  at?: string;
  sessionId: string;
  model: string;
  upstreamModel: string;
  preparedEnvelope: Pick<HostRequestEnvelope, "messages" | "metadata" | "instructions">;
  stability?: Omit<Parameters<typeof buildStabilityVisualSnapshotFromEnvelopes>[0], "at" | "sessionId" | "model" | "upstreamModel" | "preparedEnvelope">;
  reductionSegments?: SharedReductionVisualSegment[];
  reductionRequestId?: string;
}): Promise<{ reductionRequestId?: string }> {
  const at = params.at ?? new Date().toISOString();
  if (params.stability) {
    await writeStabilityVisualSnapshot({
      stateDir: params.stateDir,
      snapshot: buildStabilityVisualSnapshotFromEnvelopes({
        ...params.stability,
        at,
        sessionId: params.sessionId,
        model: params.model,
        upstreamModel: params.upstreamModel,
        preparedEnvelope: params.preparedEnvelope,
      }),
    });
  }
  const segments = params.reductionSegments ?? [];
  if (segments.length === 0) return {};
  const requestId = params.reductionRequestId ?? buildBeforeCallReductionRequestId({
    at,
    sessionId: params.sessionId,
    model: params.model,
    preparedEnvelope: params.preparedEnvelope,
  });
  await writeReductionVisualSegments({
    stateDir: params.stateDir,
    at,
    sessionId: params.sessionId,
    requestId,
    model: params.model,
    upstreamModel: params.upstreamModel,
    segments,
  });
  return { reductionRequestId: requestId };
}

export async function recordBeforeCallOptimizationState(params: {
  stateDir: string;
  at?: string;
  sessionId: string;
  model: string;
  upstreamModel: string;
  preparedEnvelope: Pick<HostRequestEnvelope, "messages" | "metadata" | "instructions">;
  stability?: Omit<Parameters<typeof buildStabilityVisualSnapshotFromEnvelopes>[0], "at" | "sessionId" | "model" | "upstreamModel" | "preparedEnvelope">;
  reduction?: BeforeCallOptimizationSummary;
  recordUxEffectNow?: boolean;
}): Promise<{ reductionRequestId?: string }> {
  const at = params.at ?? new Date().toISOString();
  const reduction = params.reduction;
  if ((params.recordUxEffectNow ?? true) && reduction && reduction.savedCount > 0) {
    await recordUxEffect(params.stateDir, {
      at,
      sessionId: params.sessionId,
      model: params.model,
      countMode: reduction.countMode ?? "chars",
      beforeCount: reduction.beforeCount,
      afterCount: reduction.afterCount,
      savedCount: reduction.savedCount,
      details: reduction.details,
    });
  }
  return recordBeforeCallVisualState({
    stateDir: params.stateDir,
    at,
    sessionId: params.sessionId,
    model: params.model,
    upstreamModel: params.upstreamModel,
    preparedEnvelope: params.preparedEnvelope,
    stability: params.stability,
    reductionSegments: reduction?.segments,
    reductionRequestId: reduction?.requestId,
  });
}

export async function prepareObservedBeforeCall<TReductionSummary>(params: {
  envelope: HostRequestEnvelope;
  codec: HostPayloadCodec;
  config?: { mode?: "conservative" | "normal" | "aggressive" };
  prepareStablePrefix(envelope: HostRequestEnvelope): HostRequestEnvelope;
  applyBeforeCallReduction(args: {
    envelope: HostRequestEnvelope;
    codec: HostPayloadCodec;
  }): Promise<{ envelope: HostRequestEnvelope; summary: TReductionSummary }>;
  observability: {
    stateDir: string;
    sessionId: string;
    model: string;
    upstreamModel?: string;
    recordUxEffectNow?: boolean;
    buildStability?(args: {
      originalEnvelope: HostRequestEnvelope;
      prepared: PreparedBeforeCallResult<TReductionSummary>;
    }): Omit<
      Parameters<typeof recordBeforeCallOptimizationState>[0],
      "stateDir" | "sessionId" | "model" | "upstreamModel" | "preparedEnvelope" | "reduction"
    >["stability"];
    buildReduction?(summary: TReductionSummary): BeforeCallOptimizationSummary | undefined;
  };
}): Promise<PreparedBeforeCallResult<TReductionSummary>> {
  const originalEnvelope = params.envelope;
  const prepared = await prepareBeforeCallWithReductionSummary<TReductionSummary>({
    envelope: params.envelope,
    codec: params.codec,
    config: params.config,
    prepareStablePrefix: params.prepareStablePrefix,
    applyBeforeCallReduction: params.applyBeforeCallReduction,
  });
  const stability = params.observability.buildStability?.({
    originalEnvelope,
    prepared,
  });
  const reduction = prepared.reductionSummary
    ? params.observability.buildReduction?.(prepared.reductionSummary)
    : undefined;
  if ((reduction && reduction.savedCount > 0) || stability) {
    await recordBeforeCallOptimizationState({
      stateDir: params.observability.stateDir,
      sessionId: params.observability.sessionId,
      model: params.observability.model,
      upstreamModel: params.observability.upstreamModel ?? params.observability.model,
      preparedEnvelope: prepared.envelope,
      stability,
      reduction,
      recordUxEffectNow: params.observability.recordUxEffectNow,
    });
  }
  return prepared;
}

export async function writeReductionVisualSegments(params: {
  stateDir: string;
  at?: string;
  sessionId: string;
  requestId: string;
  model: string;
  upstreamModel: string;
  segments: SharedReductionVisualSegment[];
}): Promise<void> {
  const at = params.at ?? new Date().toISOString();
  for (const segment of params.segments) {
    await appendReductionVisualSnapshot(params.stateDir, {
      kind: "reduction",
      at,
      sessionId: params.sessionId,
      requestId: params.requestId,
      model: params.model,
      upstreamModel: params.upstreamModel,
      segmentId: segment.segmentId,
      itemIndex: segment.itemIndex,
      field: segment.field,
      blockIndex: segment.blockIndex,
      blockKey: segment.blockKey,
      toolName: segment.toolName,
      dataPath: segment.dataPath,
      savedChars: Number(segment.savedChars ?? 0),
      beforeText: String(segment.beforeText ?? ""),
      afterText: String(segment.afterText ?? ""),
      report: Array.isArray(segment.report) ? segment.report : [],
    });
  }
}

export async function writeStabilityVisualSnapshot(params: {
  stateDir: string;
  snapshot: StabilityVisualSnapshot;
}): Promise<void> {
  await appendStabilityVisualSnapshot(params.stateDir, params.snapshot);
}
