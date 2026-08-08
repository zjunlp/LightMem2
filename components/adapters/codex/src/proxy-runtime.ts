/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import {
  findFirstMessageText,
  prepareObservedBeforeCall,
} from "@lightmem2/product-surface";
import {
  countTextWithPreciseTokens,
  createStaticStatePathResolver,
  type HostRequestEnvelope,
  prepareBeforeCallWithReductionSummary,
  recordUxEffect,
  sendJsonResponse,
  startHostGatewayRuntimeServer,
  setForwardResponseHeaders,
} from "@lightmem2/host-adapter";
import { configureStatePathResolver } from "@lightmem2/artifact-store";
import type { TokenPilotCodexConfig } from "./config.js";
import {
  defaultCodexConfigPath,
  resolveUpstreamProvider,
} from "./config.js";
import type { TokenPilotCodexLogger } from "./logger.js";
import {
  createCodexSessionResolver,
  createCodexResponsesPayloadCodec,
  extractResponsesInputText,
  syncPayloadFromEnvelope,
} from "./responses-codec.js";
import {
  type CodexReductionSummary,
  reduceCodexRequestEnvelope,
} from "./reduction.js";
import {
  buildStabilityVisualSnapshotFromEnvelopes,
  canonicalizeEnvelopeTools,
} from "@lightmem2/stabilizer";
import { prepareCodexStablePrefix } from "./stable-prefix.js";
import {
  requestUpstreamResponses,
  requestUpstreamResponsesStream,
} from "./upstream.js";
import {
  appendCodexRecentTurnBinding,
  indexCodexHostSessionAlias,
  indexCodexPromptCacheKeySession,
  indexCodexResponseSession,
  mergeCodexSessionSnapshot,
  loadCodexSessionSnapshot,
  resolveCodexSessionIdByPromptCacheKey,
  resolveCodexSessionIdByResponseId,
  upsertCodexSessionSnapshot,
} from "./session-state.js";
import { snapshotCodexResponsesStream } from "./stream-observer.js";
import { appendTrace } from "./trace.js";
import { appendCodexCacheAuditRecord, buildCodexCacheAuditSnapshot } from "./cache-audit.js";
import { initializeCodexTokenPilotPreset } from "./preset.js";
import {
  appendCodexRequestJournalEntry,
  appendCodexResponseJournalEntry,
  buildCodexEffectiveHistory,
  collectCodexResponseItemsFromStream,
  parseCodexRollout,
  validateCodexRolloutBootstrap,
} from "./context-history/index.js";
import type {
  CodexJournalStatus,
  CodexRequestJournalEntry,
  JsonObject,
} from "./context-history/types.js";
import {
  CODEX_REBASE_API_VERSION,
  CODEX_REBASE_ITEM_SCHEMA_VERSION,
  CODEX_REBASE_WIRE_MODE,
  acquireCodexRebaseSessionLock,
  buildCodexRebaseRequest,
  codexRebaseEndpointIdentity,
  executeCodexProviderContinuationWithReplay,
  executeCodexRebaseWithFallback,
  failPendingCodexRebaseEpochsAfterRestart,
  resolveCodexProviderContinuationCompatibility,
  withCodexRebaseReplayAccountingInput,
} from "./context-rewrite/index.js";
import type {
  CodexRebaseCapabilityEvidence,
  CodexMutationPlan,
  CodexRebaseRequestResult,
} from "./context-rewrite/types.js";

export type CodexProxyRuntime = {
  baseUrl: string;
  close(): Promise<void>;
};

async function recordCodexUxReduction(params: {
  stateDir: string;
  sessionId: string;
  model: string;
  originalRequestText: string;
  reducedRequestText: string;
}): Promise<void> {
  const beforeCount = countTextWithPreciseTokens(params.model, params.originalRequestText);
  const afterCount = countTextWithPreciseTokens(params.model, params.reducedRequestText);
  const countMode = beforeCount.mode === "openai_tokens" && afterCount.mode === "openai_tokens"
    ? "openai_tokens"
    : "chars";
  const savedCount = countMode === "chars"
    ? Math.max(0, params.originalRequestText.length - params.reducedRequestText.length)
    : Math.max(0, beforeCount.count - afterCount.count);
  if (savedCount <= 0) return;
  await recordUxEffect(params.stateDir, {
    at: new Date().toISOString(),
    sessionId: params.sessionId,
    model: params.model,
    countMode,
    beforeCount: countMode === "chars" ? params.originalRequestText.length : beforeCount.count,
    afterCount: countMode === "chars" ? params.reducedRequestText.length : afterCount.count,
    savedCount,
    details: {
      requestSavedCount: savedCount,
    },
  });
}

function normalizeResponsesInputForUpstream(input: any): void {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    if (type === "function_call" && typeof item.arguments !== "string" && item.arguments != null) {
      item.arguments = JSON.stringify(item.arguments);
    }
    if (type === "function_call_output" && typeof item.output !== "string" && item.output != null) {
      item.output = JSON.stringify(item.output);
    }
  }
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    return asJsonObject(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function codexMutationPlanId(plan: CodexMutationPlan): string {
  return `plan-${hashJson({
    baseRevision: plan.baseRevision ?? null,
    operations: plan.operations,
  })}`;
}

function encodedRequestPayload(params: {
  codec: ReturnType<typeof createCodexResponsesPayloadCodec>;
  envelope: HostRequestEnvelope;
  fallback: JsonObject;
}): JsonObject {
  const encoded = asJsonObject(params.codec.encodeRequest(params.envelope));
  return encoded ? cloneJsonObject(encoded) : cloneJsonObject(params.fallback);
}

function responsePayloadStatus(response: JsonObject | undefined): CodexJournalStatus | undefined {
  const status = typeof response?.status === "string" ? response.status.toLowerCase() : undefined;
  if (!status) return undefined;
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  return "incomplete";
}

function nonStreamRequestStatus(params: {
  httpStatus: number;
  response: JsonObject | undefined;
}): CodexJournalStatus {
  if (params.httpStatus < 200 || params.httpStatus >= 300) return "failed";
  return responsePayloadStatus(params.response) ?? "completed";
}

function streamRequestStatus(params: {
  httpStatus: number;
  collected: ReturnType<typeof collectCodexResponseItemsFromStream>;
}): CodexJournalStatus {
  if (params.httpStatus < 200 || params.httpStatus >= 300) return "failed";
  if (params.collected.status === "failed") return "failed";
  const sawCompleted = (params.collected.eventTypeCounts["response.completed"] ?? 0) > 0;
  if (params.collected.status !== "completed" || !sawCompleted) return "incomplete";
  return "completed";
}

function truncateJournalError(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}...` : trimmed;
}

function activeMutationPlan(config: TokenPilotCodexConfig): CodexMutationPlan | undefined {
  const plan = config.contextRewrite.mutationPlan;
  return plan && plan.operations.length > 0 ? plan : undefined;
}

function canAttemptCodexRebase(params: {
  config: TokenPilotCodexConfig;
  payload: JsonObject;
  requestEntry?: CodexRequestJournalEntry;
}): boolean {
  return Boolean(
    params.config.contextRewrite.enabled
    && params.config.contextRewrite.mode === "response_chain_rebase"
    && params.config.contextRewrite.failureMode === "bypass"
    && params.config.contextRewrite.retryOriginalRequest
    && params.requestEntry
    && activeMutationPlan(params.config)
    && typeof params.payload.previous_response_id === "string"
    && params.payload.previous_response_id,
  );
}

export async function startCodexResponsesProxy(params: {
  config: TokenPilotCodexConfig;
  logger: TokenPilotCodexLogger;
  codexConfigPath?: string;
  allowMockFixtureEvidence?: boolean;
}): Promise<CodexProxyRuntime> {
  initializeCodexTokenPilotPreset();
  const { config, logger } = params;
  if (!config.enabled) {
    throw new Error("TokenPilot Codex adapter is disabled by config");
  }
  configureStatePathResolver(createStaticStatePathResolver({
    hostId: "codex",
    displayName: "Codex",
    stateDir: config.stateDir,
    namespaceDir: "tokenpilot",
  }));
  await mkdir(config.stateDir, { recursive: true });
  const upstream = await resolveUpstreamProvider(config, params.codexConfigPath ?? defaultCodexConfigPath());
  const upstreamProviderName = upstream.name ?? config.upstreamProvider ?? "OpenAI";
  const epochRecoveryBySession = new Map<string, Promise<void>>();

  async function recoverSessionEpochsAfterRestart(sessionId: string): Promise<void> {
    let recovery = epochRecoveryBySession.get(sessionId);
    if (!recovery) {
      recovery = (async () => {
        const sessionLock = await acquireCodexRebaseSessionLock({
          stateDir: config.stateDir,
          sessionId,
        });
        if (!sessionLock) {
          epochRecoveryBySession.delete(sessionId);
          await appendTrace(config.stateDir, {
            stage: "context_rewrite_pending_epoch_recovery_deferred",
            sessionId,
            reason: "session_lock_busy",
          });
          return;
        }
        try {
          const failed = await failPendingCodexRebaseEpochsAfterRestart({
            stateDir: config.stateDir,
            sessionId,
          });
          if (failed.length > 0) {
            await appendTrace(config.stateDir, {
              stage: "context_rewrite_pending_epochs_recovered",
              sessionId,
              failedEpochIds: failed.map((entry) => entry.epochId),
            });
          }
        } finally {
          await sessionLock.release();
        }
      })().catch(async (err) => {
        epochRecoveryBySession.delete(sessionId);
        try {
          await appendTrace(config.stateDir, {
            stage: "context_rewrite_pending_epoch_recovery_failed",
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // Recovery remains best effort so normal proxying can continue.
        }
      });
      epochRecoveryBySession.set(sessionId, recovery);
    }
    await recovery;
  }

  const runtime = await startHostGatewayRuntimeServer({
    port: config.proxyPort,
    requestPath: "/v1/responses",
    basePath: "/v1",
    healthPayload: {
      ok: true,
      adapter: "tokenpilot-codex",
      upstream: upstreamProviderName,
      stateDir: config.stateDir,
    },
    async handleRequest({ req, res, body }) {
      const inboundPayload = JSON.parse(body) as JsonObject;
      normalizeResponsesInputForUpstream(inboundPayload?.input);
      const inboundPromptCacheKey =
        typeof inboundPayload?.prompt_cache_key === "string" ? inboundPayload.prompt_cache_key.trim() : "";
      const mappedPreviousSessionId =
        typeof inboundPayload?.previous_response_id === "string"
          ? await resolveCodexSessionIdByResponseId(config.stateDir, inboundPayload.previous_response_id)
          : undefined;
      const mappedPromptCacheSessionId =
        !mappedPreviousSessionId && inboundPromptCacheKey
          ? await resolveCodexSessionIdByPromptCacheKey(config.stateDir, inboundPromptCacheKey)
          : undefined;
      const codec = createCodexResponsesPayloadCodec(
        createCodexSessionResolver({
          mappedPreviousSessionId: mappedPreviousSessionId ?? mappedPromptCacheSessionId,
        }),
      );
      let envelope = codec.decodeRequest(inboundPayload);
      const inboundModel = envelope.model;
      const model = inboundModel.startsWith("tokenpilot/")
        ? inboundModel.slice("tokenpilot/".length)
        : inboundModel;
      if (model !== inboundModel) {
        envelope = { ...envelope, model };
      }
      const sessionId = envelope.session.sessionId;
      await recoverSessionEpochsAfterRestart(sessionId);
      if (inboundPromptCacheKey) {
        if (
          inboundPromptCacheKey !== sessionId
          && !inboundPromptCacheKey.startsWith("lightmem2-codex-")
        ) {
          await mergeCodexSessionSnapshot(config.stateDir, inboundPromptCacheKey, sessionId);
          await indexCodexHostSessionAlias(config.stateDir, inboundPromptCacheKey, sessionId);
        }
        await indexCodexPromptCacheKeySession(config.stateDir, inboundPromptCacheKey, sessionId);
      }
      const originalPayload = encodedRequestPayload({
        codec,
        envelope,
        fallback: inboundPayload,
      });
      normalizeResponsesInputForUpstream(originalPayload?.input);
      const originalRequestText = extractResponsesInputText(originalPayload?.input);

      let requestJournalEntry: CodexRequestJournalEntry | undefined;
      try {
        requestJournalEntry = await appendCodexRequestJournalEntry({
          stateDir: config.stateDir,
          sessionId,
          payload: originalPayload,
          status: "pending",
        });
      } catch (err) {
        await appendTrace(config.stateDir, {
          stage: "context_history_request_journal_failed",
          sessionId,
          model,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      let rebaseRequest: CodexRebaseRequestResult | undefined;
      let rebasePlanId: string | undefined;
      let continuationReplayRequest: CodexRebaseRequestResult | undefined;
      let rebaseAccounting = rebaseRequest?.accounting;
      const mutationPlan = activeMutationPlan(config);
      let effectiveHistoryPromise: ReturnType<typeof buildCodexEffectiveHistory> | undefined;
      const effectiveHistoryForHead = (): ReturnType<typeof buildCodexEffectiveHistory> => {
        if (!requestJournalEntry || typeof originalPayload.previous_response_id !== "string") {
          throw new Error("Codex effective history requires a journaled response-chain request");
        }
        effectiveHistoryPromise ??= buildCodexEffectiveHistory({
          stateDir: config.stateDir,
          sessionId,
          headResponseId: originalPayload.previous_response_id,
          currentRequestId: requestJournalEntry.requestId,
          async rolloutParserBootstrap() {
            const snapshot = await loadCodexSessionSnapshot(config.stateDir, sessionId);
            if (!snapshot?.transcriptPath) return null;
            const rollout = await parseCodexRollout(snapshot.transcriptPath);
            if (!rollout) return null;
            const validation = validateCodexRolloutBootstrap({
              rollout,
              // prompt_cache_key is an upstream cache namespace, not the
              // Codex host session identity used by rollout metadata.
              expectedCodexSessionId: snapshot.codexSessionId,
              snapshotCodexSessionId: snapshot.codexSessionId,
              sourceModel: snapshot.latestModel,
              sourceUpstreamProvider: snapshot.latestUpstreamProvider,
              currentModel: model,
              currentCodexProvider: config.providerName,
              currentUpstreamProvider: upstreamProviderName,
            });
            if (validation.rejectionReason) {
              await appendTrace(config.stateDir, {
                stage: "context_history_rollout_bootstrap_rejected",
                sessionId,
                reason: validation.rejectionReason,
              });
            }
            return validation.history;
          },
        });
        return effectiveHistoryPromise;
      };
      if (canAttemptCodexRebase({ config, payload: originalPayload, requestEntry: requestJournalEntry })
        && mutationPlan
        && requestJournalEntry) {
        const planId = codexMutationPlanId(mutationPlan);
        try {
          const effectiveHistory = await effectiveHistoryForHead();
          rebaseRequest = buildCodexRebaseRequest({
            sessionId,
            planId,
            baseRevision: mutationPlan.baseRevision ?? effectiveHistory.revision,
            originalPayload,
            effectiveHistory,
            currentInput: originalPayload.input,
            mutationPlan,
          });
          rebasePlanId = planId;
        } catch (err) {
          await appendTrace(config.stateDir, {
            stage: "context_rewrite_rebase_deferred",
            sessionId,
            model,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const canPrepareContinuationReplay = !rebaseRequest
        && requestJournalEntry
        && typeof originalPayload.previous_response_id === "string"
        && config.contextRewrite.providerCompatibilityProbe !== "disabled";
      if (canPrepareContinuationReplay) {
        try {
          const effectiveHistory = await effectiveHistoryForHead();
          continuationReplayRequest = buildCodexRebaseRequest({
            sessionId,
            planId: "provider-continuation-replay",
            baseRevision: effectiveHistory.revision,
            originalPayload,
            effectiveHistory,
            currentInput: originalPayload.input,
            mutationPlan: { baseRevision: effectiveHistory.revision, operations: [] },
          });
        } catch (err) {
          await appendTrace(config.stateDir, {
            stage: "provider_continuation_replay_deferred",
            sessionId,
            model,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const payload = cloneJsonObject(rebaseRequest?.payload ?? originalPayload);
      normalizeResponsesInputForUpstream(payload?.input);
      const preparedEnvelope = rebaseRequest ? codec.decodeRequest(payload) : envelope;
      const prepareStablePrefixForCodex = (nextEnvelope: HostRequestEnvelope) => (
        prepareCodexStablePrefix(canonicalizeEnvelopeTools(nextEnvelope), config)
      );
      const applyBeforeCallReductionForCodex = async (args: {
        envelope: HostRequestEnvelope;
        codec: any;
      }) => reduceCodexRequestEnvelope({
        envelope: args.envelope,
        codec: args.codec,
        config,
      });
      const prepared = await prepareObservedBeforeCall<CodexReductionSummary>({
        envelope: preparedEnvelope,
        codec,
        config: { mode: "normal" },
        prepareStablePrefix: prepareStablePrefixForCodex,
        applyBeforeCallReduction: applyBeforeCallReductionForCodex,
        observability: {
          stateDir: config.stateDir,
          sessionId,
          model,
          recordUxEffectNow: false,
          buildStability({ originalEnvelope, prepared }) {
            return prepared.diagnostics.stablePrefixApplied === true
              ? buildStabilityVisualSnapshotFromEnvelopes({
                sessionId,
                model,
                upstreamModel: model,
                originalEnvelope,
                preparedEnvelope: prepared.envelope,
                dynamicContextTarget: config.hooks.dynamicContextTarget,
                getDeveloperText(envelope) {
                  return findFirstMessageText(envelope, (message: any) => {
                    if (!message || typeof message !== "object" || message.role !== "system") return false;
                    const originalRole = message.metadata?.__codexOriginalRole;
                    return originalRole === "developer" || originalRole === "system";
                  });
                },
              })
              : undefined;
          },
          buildReduction(reductionSummary) {
            return reductionSummary.savedChars > 0
              ? {
                countMode: "chars",
                beforeCount: reductionSummary.beforeChars,
                afterCount: reductionSummary.afterChars,
                savedCount: reductionSummary.savedChars,
                details: {
                  requestSavedCount: reductionSummary.savedChars,
                },
                segments: reductionSummary.visualSegments ?? [],
              }
              : undefined;
          },
        },
      });
      const reductionSummary = prepared.reductionSummary;
      syncPayloadFromEnvelope(payload, prepared.envelope, codec);
      normalizeResponsesInputForUpstream(payload?.input);
      if (rebaseRequest) {
        rebaseAccounting = withCodexRebaseReplayAccountingInput(rebaseRequest.accounting, payload.input);
      }
      const fallbackPayload = cloneJsonObject(originalPayload);
      if (rebaseRequest) {
        const fallbackPrepared = await prepareBeforeCallWithReductionSummary<CodexReductionSummary>({
          envelope,
          codec,
          config: { mode: "normal" },
          prepareStablePrefix: prepareStablePrefixForCodex,
          applyBeforeCallReduction: applyBeforeCallReductionForCodex,
        });
        syncPayloadFromEnvelope(fallbackPayload, fallbackPrepared.envelope, codec);
        normalizeResponsesInputForUpstream(fallbackPayload?.input);
      }
      let continuationReplayPayload: JsonObject | undefined;
      if (continuationReplayRequest) {
        continuationReplayPayload = cloneJsonObject(continuationReplayRequest.payload);
        const continuationEnvelope = codec.decodeRequest(continuationReplayPayload);
        const continuationPrepared = await prepareBeforeCallWithReductionSummary<CodexReductionSummary>({
          envelope: continuationEnvelope,
          codec,
          config: { mode: "normal" },
          prepareStablePrefix: prepareStablePrefixForCodex,
          applyBeforeCallReduction: applyBeforeCallReductionForCodex,
        });
        syncPayloadFromEnvelope(continuationReplayPayload, continuationPrepared.envelope, codec);
        normalizeResponsesInputForUpstream(continuationReplayPayload?.input);
      }
      const requestText = extractResponsesInputText(payload?.input);
      const cacheAuditSnapshot = buildCodexCacheAuditSnapshot({
        envelope: prepared.envelope,
        sessionId,
        model,
        stream: payload.stream === true,
        originalRequestPromptCacheKey:
          typeof prepared.envelope.metadata?.originalPromptCacheKey === "string"
            ? prepared.envelope.metadata.originalPromptCacheKey
            : null,
        requestPromptCacheKey:
          typeof prepared.envelope.metadata?.frameworkStablePromptCacheKey === "string"
            ? prepared.envelope.metadata.frameworkStablePromptCacheKey
            : typeof prepared.envelope.metadata?.promptCacheKey === "string"
              ? prepared.envelope.metadata.promptCacheKey
            : null,
      });
      await appendTrace(config.stateDir, {
        stage: "proxy_before_call",
        sessionId,
        model,
        stream: payload.stream === true,
        stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
        recoveryInjected: prepared.diagnostics.recoveryInjected === true,
        reductionApplied: prepared.diagnostics.reductionApplied === true,
        reductionSavedChars: reductionSummary?.savedChars ?? 0,
        reductionChangedItems: reductionSummary?.changedItems ?? 0,
        reductionChangedBlocks: reductionSummary?.changedBlocks ?? 0,
        reductionSkippedReason: reductionSummary?.skippedReason ?? null,
        reductionPassEffects: reductionSummary?.passEffects ?? [],
        promptCacheKey: prepared.envelope.metadata?.promptCacheKey ?? null,
        contextRewriteEnabled: config.contextRewrite.enabled,
        contextRewritePlanned: Boolean(rebaseRequest),
        providerContinuationReplayPrepared: Boolean(continuationReplayPayload),
      });

      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const sendUpstream = (nextPayload: JsonObject) => requestUpstreamResponses({
        upstream,
        payload: nextPayload,
        inboundAuthorization: authorization,
        stateDir: config.stateDir,
      });
      const acceptedEvidence: CodexRebaseCapabilityEvidence[] = params.allowMockFixtureEvidence
        ? ["real_provider", "mock_fixture"]
        : ["real_provider"];
      const capabilityStore = {
        stateDir: config.stateDir,
        provider: upstreamProviderName,
        model,
        wireMode: CODEX_REBASE_WIRE_MODE,
        apiVersion: CODEX_REBASE_API_VERSION,
        endpointId: codexRebaseEndpointIdentity(upstream.baseUrl),
        itemSchemaVersion: CODEX_REBASE_ITEM_SCHEMA_VERSION,
        probeMode: config.contextRewrite.providerCompatibilityProbe,
        acceptedEvidence,
        evidenceSource: params.allowMockFixtureEvidence ? "mock_fixture" : "real_provider",
      } as const;
      const nativeStreamChainVerified = payload.stream === true
        && continuationReplayPayload
        && await resolveCodexProviderContinuationCompatibility({
          chainedPayload: payload,
          capabilityStore,
        }) === "verified_supported";
      let contextRewriteOutcome: string | undefined;
      let contextHistoryJournalPersisted = false;

      const appendStreamContextHistory = async (paramsForJournal: {
        status: number;
        rawStreamText: string;
        committed: boolean;
      }): Promise<void> => {
        if (!requestJournalEntry) return;
        const collected = collectCodexResponseItemsFromStream(paramsForJournal.rawStreamText);
        const status = streamRequestStatus({
          httpStatus: paramsForJournal.status,
          collected,
        });
        const error = status === "failed" ? truncateJournalError(paramsForJournal.rawStreamText) : undefined;
        await appendCodexResponseJournalEntry({
          stateDir: config.stateDir,
          sessionId,
          requestId: requestJournalEntry.requestId,
          rawStreamText: paramsForJournal.rawStreamText,
          previousResponseId: paramsForJournal.committed
            ? null
            : typeof originalPayload.previous_response_id === "string"
              ? originalPayload.previous_response_id
              : null,
          status,
          error,
        });
        await appendCodexRequestJournalEntry({
          stateDir: config.stateDir,
          sessionId,
          requestId: requestJournalEntry.requestId,
          payload: originalPayload,
          committedInputItems: paramsForJournal.committed && Array.isArray(payload.input)
            ? payload.input as JsonObject[]
            : undefined,
          status,
          error,
        });
      };

      const appendNonStreamContextHistory = async (paramsForJournal: {
        response: ReturnType<typeof parseJsonObject>;
        responseText: string;
        httpStatus: number;
        committed: boolean;
      }): Promise<void> => {
        if (!requestJournalEntry) return;
        const status = nonStreamRequestStatus({
          httpStatus: paramsForJournal.httpStatus,
          response: paramsForJournal.response,
        });
        const error = status === "failed" ? truncateJournalError(paramsForJournal.responseText) : undefined;
        await appendCodexResponseJournalEntry({
          stateDir: config.stateDir,
          sessionId,
          requestId: requestJournalEntry.requestId,
          response: paramsForJournal.response,
          previousResponseId: paramsForJournal.committed
            ? null
            : typeof originalPayload.previous_response_id === "string"
              ? originalPayload.previous_response_id
              : null,
          status,
          error,
        });
        await appendCodexRequestJournalEntry({
          stateDir: config.stateDir,
          sessionId,
          requestId: requestJournalEntry.requestId,
          payload: originalPayload,
          committedInputItems: paramsForJournal.committed && Array.isArray(payload.input)
            ? payload.input as JsonObject[]
            : undefined,
          status,
          error,
        });
      };

      const persistAcceptedRebaseResponse = async (paramsForCommit: {
        response: { status: number; text: string };
        newResponseId: string;
      }): Promise<void> => {
        if (payload.stream === true) {
          await appendStreamContextHistory({
            status: paramsForCommit.response.status,
            rawStreamText: paramsForCommit.response.text,
            committed: true,
          });
        } else {
          await appendNonStreamContextHistory({
            response: parseJsonObject(paramsForCommit.response.text),
            responseText: paramsForCommit.response.text,
            httpStatus: paramsForCommit.response.status,
            committed: true,
          });
        }
        await indexCodexResponseSession(config.stateDir, paramsForCommit.newResponseId, sessionId);
        contextHistoryJournalPersisted = true;
      };

      const sendRebasedOrCurrentPayload = async () => {
        if (rebaseRequest && requestJournalEntry && rebasePlanId) {
          const result = await executeCodexRebaseWithFallback({
            sessionId,
            planId: rebasePlanId,
            epochId: `epoch-${requestJournalEntry.requestId}`,
            originalPayload: fallbackPayload,
            rebasedPayload: payload,
            sendUpstream,
            beforeCommit: persistAcceptedRebaseResponse,
            accounting: rebaseAccounting,
            epochStore: {
              stateDir: config.stateDir,
              oldPreviousResponseId: String(originalPayload.previous_response_id),
              oldRevision: rebaseRequest.oldRevision,
              newRevision: rebaseRequest.rebaseRevision,
            },
            cooldownStore: {
              stateDir: config.stateDir,
              cooldownMs: config.contextRewrite.cooldownMs,
            },
            capabilityStore,
          });
          contextRewriteOutcome = result.outcome;
          if (result.outcome !== "committed") contextHistoryJournalPersisted = false;
          return result.response;
        }
        if (continuationReplayPayload) {
          const result = await executeCodexProviderContinuationWithReplay({
            chainedPayload: payload,
            statelessReplayPayload: continuationReplayPayload,
            sendUpstream,
            capabilityStore,
          });
          contextRewriteOutcome = result.outcome;
          return result.response;
        }
        return sendUpstream(payload);
      };
      const recordStreamResponse = async (paramsForRecord: {
        status: number;
        rawStreamText: string;
      }): Promise<void> => {
        const snapshot = snapshotCodexResponsesStream(paramsForRecord.rawStreamText);
        const logicalPreviousResponseId = contextRewriteOutcome === "committed"
          ? undefined
          : typeof originalPayload.previous_response_id === "string"
            ? originalPayload.previous_response_id
            : undefined;
        const collected = collectCodexResponseItemsFromStream(paramsForRecord.rawStreamText);
        const requestStatus = streamRequestStatus({
          httpStatus: paramsForRecord.status,
          collected,
        });
        await recordCodexUxReduction({
          stateDir: config.stateDir,
          sessionId,
          model,
          originalRequestText,
          reducedRequestText: requestText,
        });
        await appendCodexCacheAuditRecord({
          stateDir: config.stateDir,
          snapshot: cacheAuditSnapshot,
          responsePromptCacheKey: snapshot.responsePromptCacheKey ?? null,
          usage: snapshot.usage ?? null,
          status: paramsForRecord.status,
        });
        if (requestJournalEntry && !contextHistoryJournalPersisted) {
          try {
            await appendStreamContextHistory({
              status: paramsForRecord.status,
              rawStreamText: paramsForRecord.rawStreamText,
              committed: contextRewriteOutcome === "committed",
            });
          } catch (err) {
            await appendTrace(config.stateDir, {
              stage: "context_history_response_journal_failed",
              sessionId,
              model,
              stream: true,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        await appendTrace(config.stateDir, {
          stage: "proxy_after_call",
          sessionId,
          model,
          status: paramsForRecord.status,
          stream: true,
          completed: requestStatus === "completed",
          streamStatus: collected.status,
          malformedEventCount: collected.malformedEventCount,
          responseChars: paramsForRecord.rawStreamText.length,
          assistantChars: snapshot.assistantText.length,
          responseId: snapshot.responseId ?? null,
          previousResponseId: logicalPreviousResponseId ?? null,
          contextRewriteOutcome: contextRewriteOutcome ?? null,
        });
        await upsertCodexSessionSnapshot(config.stateDir, sessionId, {
          latestResponseId: snapshot.responseId,
          previousResponseId: logicalPreviousResponseId,
          latestModel: model,
          latestUpstreamProvider: upstreamProviderName,
          disclosedReadPaths: reductionSummary?.disclosedReadPaths,
        });
        if (typeof snapshot.responseId === "string" && snapshot.responseId) {
          await indexCodexResponseSession(config.stateDir, snapshot.responseId, sessionId);
        }
        await appendCodexRecentTurnBinding(config.stateDir, {
          sessionId,
          responseId: snapshot.responseId,
          previousResponseId: logicalPreviousResponseId,
          model,
          requestChars: requestText.length,
          responseChars: paramsForRecord.rawStreamText.length,
          assistantChars: snapshot.assistantText.length,
          stream: true,
          updatedAt: new Date().toISOString(),
        });
      };
      if (payload.stream === true) {
        if ((rebaseRequest && requestJournalEntry)
          || (continuationReplayPayload && !nativeStreamChainVerified)) {
          const upstreamResp = await sendRebasedOrCurrentPayload();
          res.statusCode = upstreamResp.status;
          setForwardResponseHeaders(res, upstreamResp.headers, "text/event-stream; charset=utf-8");
          await recordStreamResponse({
            status: upstreamResp.status,
            rawStreamText: upstreamResp.text,
          });
          res.end(upstreamResp.text);
          return;
        }
        const upstreamResp = await requestUpstreamResponsesStream({
          upstream,
          payload,
          inboundAuthorization: authorization,
          stateDir: config.stateDir,
        });
        res.statusCode = upstreamResp.status;
        setForwardResponseHeaders(res, upstreamResp.headers, "text/event-stream; charset=utf-8");
        const streamChunks: Buffer[] = [];
        upstreamResp.stream.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          streamChunks.push(buffer);
          res.write(buffer);
        });
        upstreamResp.stream.once("end", async () => {
          const rawStreamText = Buffer.concat(streamChunks).toString("utf8");
          try {
            await recordStreamResponse({
              status: upstreamResp.status,
              rawStreamText,
            });
            res.end();
          } catch (err) {
            void appendTrace(config.stateDir, {
              stage: "proxy_after_call",
              sessionId,
              model,
              status: upstreamResp.status,
              stream: true,
              completed: false,
              error: err instanceof Error ? err.message : String(err),
            });
            if (!res.destroyed) {
              res.destroy(err instanceof Error ? err : new Error(String(err)));
            }
          }
        });
        upstreamResp.stream.once("error", (err) => {
          void appendTrace(config.stateDir, {
            stage: "proxy_after_call",
            sessionId,
            model,
            status: upstreamResp.status,
            stream: true,
            completed: false,
            error: err instanceof Error ? err.message : String(err),
          });
          if (!res.destroyed) {
            res.destroy(err instanceof Error ? err : new Error(String(err)));
          }
        });
        return;
      }

      const upstreamResp = await sendRebasedOrCurrentPayload();
      const responseJson = parseJsonObject(upstreamResp.text);
      let responseId = typeof responseJson?.id === "string" && responseJson.id.trim()
        ? responseJson.id
        : undefined;
      const previousResponseId = contextRewriteOutcome === "committed"
        ? undefined
        : typeof originalPayload.previous_response_id === "string"
          ? originalPayload.previous_response_id
          : undefined;
      let assistantChars = 0;
      let toolCallCount = 0;
      try {
        const decoded = codec.decodeResponse(responseJson ?? JSON.parse(upstreamResp.text), prepared.envelope);
        responseId = typeof decoded.metadata?.responseId === "string" && decoded.metadata.responseId
          ? decoded.metadata.responseId
          : responseId;
        assistantChars = decoded.assistantText?.length ?? 0;
        toolCallCount = decoded.toolCalls?.length ?? 0;
        await appendCodexCacheAuditRecord({
          stateDir: config.stateDir,
          snapshot: cacheAuditSnapshot,
          responsePromptCacheKey:
            typeof decoded.metadata?.promptCacheKey === "string"
              ? decoded.metadata.promptCacheKey
              : null,
          usage: decoded.usage ?? null,
          status: upstreamResp.status,
        });
      } catch {
        // Some upstream error payloads may not match the expected Responses shape.
      }
      if (requestJournalEntry && !contextHistoryJournalPersisted) {
        try {
          await appendNonStreamContextHistory({
            response: responseJson,
            responseText: upstreamResp.text,
            httpStatus: upstreamResp.status,
            committed: contextRewriteOutcome === "committed",
          });
        } catch (err) {
          await appendTrace(config.stateDir, {
            stage: "context_history_response_journal_failed",
            sessionId,
            model,
            stream: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await recordCodexUxReduction({
        stateDir: config.stateDir,
        sessionId,
        model,
        originalRequestText,
        reducedRequestText: requestText,
      });
      await upsertCodexSessionSnapshot(config.stateDir, sessionId, {
        latestResponseId: responseId,
        previousResponseId,
        latestModel: model,
        latestUpstreamProvider: upstreamProviderName,
        disclosedReadPaths: reductionSummary?.disclosedReadPaths,
      });
      if (typeof responseId === "string" && responseId) {
        await indexCodexResponseSession(config.stateDir, responseId, sessionId);
      }
      await appendCodexRecentTurnBinding(config.stateDir, {
        sessionId,
        responseId,
        previousResponseId,
        model,
        requestChars: requestText.length,
        responseChars: upstreamResp.text.length,
        assistantChars,
        toolCallCount,
        stream: false,
        updatedAt: new Date().toISOString(),
      });
      await appendTrace(config.stateDir, {
        stage: "proxy_after_call",
        sessionId,
        model,
        status: upstreamResp.status,
        responseChars: upstreamResp.text.length,
        assistantChars,
        responseId: responseId ?? null,
        previousResponseId: previousResponseId ?? null,
        contextRewriteOutcome: contextRewriteOutcome ?? null,
      });
      res.statusCode = upstreamResp.status;
      setForwardResponseHeaders(res, upstreamResp.headers, "application/json; charset=utf-8");
      res.end(upstreamResp.text);
    },
    async handleError({ error, res }) {
      const err = error;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(message);
      sendJsonResponse(res, 500, { error: message });
    },
  });

  const baseUrl = runtime.baseUrl;
  logger.info(`proxy listening at ${baseUrl}; upstream=${upstream.baseUrl}`);
  return {
    baseUrl,
    close: runtime.close,
  };
}
