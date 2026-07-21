import { extractContentText } from "@tokenpilot/kernel";
import {
  registerProductSurfaceCacheAuditContribution,
  type ProductSurfaceCacheAuditRecord,
  type StabilityVisualSnapshot,
} from "@tokenpilot/product-surface";
import type { StabilizerRequestEnvelope } from "./contracts.js";
import { diagnoseCacheAudit } from "./cache-audit-diagnosis.js";
import {
  readRecentCacheAuditRecordsForSession,
  summarizeCacheAudit,
} from "./cache-audit-store.js";
import { rewriteTextForStablePrefix } from "./message-text.js";
import type { StablePrefixDriftReason, StablePrefixEntropyFinding } from "./stable-prefix-audit.js";

export function registerStabilizerProductSurfaceContribution(): void {
  registerProductSurfaceCacheAuditContribution({
    readRecentRecordsForSession(stateDir, sessionId, limit) {
      return readRecentCacheAuditRecordsForSession(stateDir, sessionId, limit);
    },
    summarize(records) {
      return summarizeCacheAudit(records as Parameters<typeof summarizeCacheAudit>[0]);
    },
    diagnose(record: ProductSurfaceCacheAuditRecord) {
      return diagnoseCacheAudit({
        stablePrefixFingerprint: record.stablePrefixFingerprint,
        requestPromptCacheKey: record.requestPromptCacheKey,
        responsePromptCacheKey: record.responsePromptCacheKey,
        cachedInputTokens: record.cachedInputTokens,
        baselineKind: record.baselineKind ?? "none",
        entropyFindings: record.entropyFindings as StablePrefixEntropyFinding[],
        driftReasons: record.driftReasons as StablePrefixDriftReason[],
      });
    },
  });
}

function findFirstUserMessageText(envelope: Pick<StabilizerRequestEnvelope, "messages">): string {
  const user = envelope.messages.find((message) => message?.role === "user");
  return user ? extractContentText(user.content) : "";
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
  originalEnvelope: Pick<StabilizerRequestEnvelope, "messages" | "instructions"> & { metadata?: Record<string, unknown> };
  preparedEnvelope: Pick<StabilizerRequestEnvelope, "messages" | "instructions"> & { metadata?: Record<string, unknown> };
  sessionId: string;
  model: string;
  upstreamModel: string;
  dynamicContextTarget: StabilityVisualSnapshot["dynamicContextTarget"];
  getDeveloperText: (envelope: Pick<StabilizerRequestEnvelope, "messages" | "instructions"> & { metadata?: Record<string, unknown> }) => string;
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
