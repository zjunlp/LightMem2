/* eslint-disable @typescript-eslint/no-explicit-any */
import { runBeforeCallReductionOrchestrator } from "@tokenpilot/host-adapter";
import {
  findFirstMessageText,
} from "@tokenpilot/product-surface";
import { injectProceduralMemoryHints } from "./procedural-memory.js";
import {
  createOpenClawPayloadCodec,
  createOpenClawSessionResolver,
  syncOpenClawPayloadFromEnvelope,
} from "./openclaw-host-adapter.js";
import { upsertOpenClawSessionSummary } from "../../session/session-summary.js";
import { injectMemoryFaultProtocolInstructionsText } from "../page-in/recovery-protocol.js";
import type { UpstreamConfig } from "./upstream.js";
import { normalizeResponsesInputForUpstream } from "./proxy-runtime-shared.js";
import { recordProxyInbound } from "./proxy-runtime-logging.js";
import { buildOpenClawCacheAuditSnapshot } from "../../cache-audit.js";
import { buildLifecyclePolicyContext } from "./lifecycle-policy-context.js";

type ProxyRequestPreparation = {
  payload: any;
  requestEnvelope: any;
  payloadCodec: any;
  model: string;
  upstreamModel: string;
  originalInputText: string;
  afterReductionInputText: string;
  beforeReductionCanonicalInput: string;
  afterReductionCanonicalInput: string;
  proxyPureForward: boolean;
  reductionTriggerMinChars: number;
  reductionMaxToolChars: number;
  resolvedSessionId: string;
  instructions: string;
  stableRewrite: any;
  rootPromptRewrite: any;
  reductionApplied: any;
  developerForwardedText: string;
  developerCanonicalText: string;
  devAndUser: any;
  firstTurnCandidate: boolean;
  originalPromptCacheKey: string;
  reductionPassOptions: any;
  cacheAuditSnapshot: Omit<import("../../cache-audit.js").OpenClawCacheAuditRecord, "at" | "responsePromptCacheKey" | "cachedInputTokens" | "usage" | "status">;
};

function buildReductionSkippedResult(
  payload: any,
  reductionTriggerMinChars: number,
  reductionMaxToolChars: number,
  skippedReason: string,
) {
  return {
    changedItems: 0,
    changedBlocks: 0,
    savedChars: 0,
    diagnostics: {
      engine: "layered",
      inputItems: Array.isArray(payload?.input) ? payload.input.length : 0,
      toolLikeItems: 0,
      candidateBlocks: 0,
      overThresholdBlocks: 0,
      triggerMinChars: reductionTriggerMinChars,
      maxToolChars: reductionMaxToolChars,
      instructionCount: 0,
      passCount: 0,
      skippedReason,
    },
  };
}

async function applyProxyReduction(
  cfg: any,
  logger: any,
  helpers: any,
  payload: any,
  resolvedSessionId: string,
  reductionPassOptions: any,
  policyModule: any,
  proxyPureForward: boolean,
  reductionTriggerMinChars: number,
  reductionMaxToolChars: number,
): Promise<any> {
  const reductionContext = {
    rawPayload: payload,
    sessionId: resolvedSessionId,
    triggerMinChars: reductionTriggerMinChars,
    maxToolChars: reductionMaxToolChars,
    proxyPureForward,
    reductionEnabled: Boolean(cfg.modules.reduction),
  };

  return runBeforeCallReductionOrchestrator(
    {
      buildSkippedResult: (context, skippedReason) =>
        buildReductionSkippedResult(
          context.rawPayload,
          context.triggerMinChars,
          context.maxToolChars,
          skippedReason,
        ),
      runReduction: async () => {
        if (cfg.stateDir) {
          void helpers.appendTaskStateTrace(cfg.stateDir, {
            stage: "proxy_reduction_session_resolved",
            resolvedSessionId,
            promptPreview: String(payload?.prompt ?? "").slice(0, 160),
          });
        }
        return helpers.applyProxyReductionToInput(
          payload,
          {
            sessionId: resolvedSessionId,
            logger,
            engine: cfg.reduction.engine,
            triggerMinChars: cfg.reduction.triggerMinChars,
            maxToolChars: cfg.reduction.maxToolChars,
            passToggles: cfg.reduction.passes,
            passOptions: {
              read_state_compaction: reductionPassOptions.readStateCompaction ?? {},
              tool_payload_trim: reductionPassOptions.toolPayloadTrim ?? {},
              html_slimming: reductionPassOptions.htmlSlimming ?? {},
              exec_output_truncation: reductionPassOptions.execOutputTruncation ?? {},
              agents_startup_optimization: reductionPassOptions.agentsStartupOptimization ?? {},
              format_slimming: reductionPassOptions.formatSlimming ?? {},
              format_cleaning: reductionPassOptions.formatCleaning ?? {},
              path_truncation: reductionPassOptions.pathTruncation ?? {},
              image_downsample: reductionPassOptions.imageDownsample ?? {},
              line_number_strip: reductionPassOptions.lineNumberStrip ?? {},
            },
            beforeCallModules: {
              policy: undefined,
            },
            cfg,
          },
          {
            applyPolicyBeforeCall: helpers.applyPolicyBeforeCall,
            buildLayeredReductionContext: (
              payloadInner: any,
              triggerMinChars: number,
              sessionId: string,
              passToggles: any,
              passOptions: any,
              segmentAnchorByCallId: any,
              orderedTurnAnchors: any,
            ) => helpers.buildLayeredReductionContext(
              payloadInner,
              triggerMinChars,
              sessionId,
              {
                memoryFaultRecoverToolName: helpers.MEMORY_FAULT_RECOVER_TOOL_NAME,
                hasRecoveryMarker: helpers.hasRecoveryMarker,
                inferObservationPayloadKind: helpers.inferObservationPayloadKind,
              },
              passToggles,
              passOptions,
              segmentAnchorByCallId,
              orderedTurnAnchors,
            ),
            isReductionPassEnabled: helpers.isReductionPassEnabled,
            loadOrderedTurnAnchors: (stateDir: string, sessionId: string) =>
              helpers.loadOrderedTurnAnchors(stateDir, sessionId, helpers.dedupeStrings),
            loadSegmentAnchorByCallId: (stateDir: string, sessionId: string) =>
              helpers.loadSegmentAnchorByCallId(stateDir, sessionId, {
                dedupeStrings: helpers.dedupeStrings,
                syncRawSemanticTurnsFromTranscript: async (dir: string, sid: string) => {
                  await helpers.syncRawSemanticTurnsFromTranscript(dir, sid, {
                    contentToText: helpers.contentToText,
                    contextSafeRecovery: helpers.contextSafeRecovery,
                    memoryFaultRecoverToolName: helpers.MEMORY_FAULT_RECOVER_TOOL_NAME,
                  });
                },
              }),
            makeLogger: helpers.makeLogger,
          },
        );
      },
    },
    reductionContext,
  );
}

async function runPolicyBeforeReduction(
  cfg: any,
  logger: any,
  helpers: any,
  payload: any,
  resolvedSessionId: string,
  policyModule: any,
): Promise<void> {
  if (!cfg.modules.policy || !policyModule) return;
  const turnCtx = buildLifecyclePolicyContext({
    sessionId: resolvedSessionId,
    model: String(payload?.model ?? "unknown"),
    prompt: helpers.extractInputText(payload?.input),
  });
  await helpers.applyPolicyBeforeCall(turnCtx, cfg, logger, {
    policy: policyModule,
  });
}

export async function prepareProxyRequest(args: {
  cfg: any;
  logger: any;
  helpers: any;
  payload: any;
  upstream: UpstreamConfig;
  resolveSessionIdForPayload: ((payload: any) => string | undefined) | undefined;
  policyModule: any;
  reductionPassOptions: any;
  dynamicContextTarget: "user" | "developer";
}): Promise<ProxyRequestPreparation> {
  const {
    cfg,
    logger,
    helpers,
    payload,
    upstream,
    resolveSessionIdForPayload,
    policyModule,
    reductionPassOptions,
    dynamicContextTarget,
  } = args;
  normalizeResponsesInputForUpstream(payload?.input);
  const sessionResolver = createOpenClawSessionResolver({
    resolveSessionIdForPayload,
    extractInputText: helpers.extractInputText,
  });
  const payloadCodec = createOpenClawPayloadCodec(
    {
      resolveSessionIdForPayload,
      extractInputText: helpers.extractInputText,
    },
    sessionResolver,
  );
  let requestEnvelope = payloadCodec.decodeRequest(payload);
  const originalInputText = helpers.extractInputText(payload?.input);
  const model = String(requestEnvelope.model ?? payload?.model ?? "");
  const upstreamModel = helpers.normalizeProxyModelId(model);
  if (upstreamModel && upstreamModel !== model) {
    requestEnvelope = {
      ...requestEnvelope,
      model: upstreamModel,
    };
    syncOpenClawPayloadFromEnvelope(payload, requestEnvelope, payloadCodec);
  }
  const proxyPureForward = cfg.proxyMode.pureForward;
  const stabilizerEnabled = !proxyPureForward && Boolean(cfg.modules.stabilizer);
  const reductionTriggerMinChars = Math.max(256, cfg.reduction.triggerMinChars ?? 2200);
  const reductionMaxToolChars = Math.max(256, cfg.reduction.maxToolChars ?? 1200);
  const resolvedSessionId = String(requestEnvelope.session.sessionId ?? "proxy-session").trim() || "proxy-session";
  if (!proxyPureForward && cfg.modules.reduction) {
    const recoveryResult = injectMemoryFaultProtocolInstructionsText(requestEnvelope.instructions);
    if (recoveryResult.changed) {
      requestEnvelope = {
        ...requestEnvelope,
        instructions: recoveryResult.instructions,
      };
      syncOpenClawPayloadFromEnvelope(payload, requestEnvelope, payloadCodec);
    }
  }
  const instructions = helpers.normalizeText(String(requestEnvelope.instructions ?? payload?.instructions ?? ""));
  const devAndUser = stabilizerEnabled ? helpers.findDeveloperAndPrimaryUser(requestEnvelope.messages) : null;
  const rootPromptCandidate = stabilizerEnabled ? helpers.findRootPromptCandidate(requestEnvelope.messages) : null;
  const firstTurnCandidate = Boolean(devAndUser);
  const rootPromptRewrite = rootPromptCandidate && stabilizerEnabled
    ? helpers.rewriteRootPromptForStablePrefix(rootPromptCandidate.text)
    : null;
  const developerCanonicalText = String(rootPromptRewrite?.canonicalPromptText ?? rootPromptCandidate?.text ?? "");
  const developerForwardedText = String(rootPromptRewrite?.forwardedPromptText ?? rootPromptCandidate?.text ?? "");
  const originalPromptCacheKey = typeof requestEnvelope.metadata?.promptCacheKey === "string" && requestEnvelope.metadata.promptCacheKey.trim().length > 0
    ? String(requestEnvelope.metadata.promptCacheKey)
    : typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0
      ? String(payload.prompt_cache_key)
      : "";
  if (stabilizerEnabled && devAndUser && rootPromptRewrite && Array.isArray(requestEnvelope.messages) && devAndUser.developerIndex >= 0) {
    const nextMessages = requestEnvelope.messages.slice();
    const forwardedDeveloperText = rootPromptRewrite.forwardedPromptText;
    nextMessages[devAndUser.developerIndex] = {
      ...(devAndUser.developerItem ?? nextMessages[devAndUser.developerIndex]),
      role: "developer",
      content: forwardedDeveloperText,
    };
    if (dynamicContextTarget === "user" && rootPromptRewrite.dynamicContextText && devAndUser.userIndex >= 0) {
      nextMessages[devAndUser.userIndex] = {
        ...(devAndUser.userItem ?? nextMessages[devAndUser.userIndex]),
        role: "user",
        content: helpers.prependTextToContent(
          (devAndUser.userItem ?? nextMessages[devAndUser.userIndex])?.content,
          rootPromptRewrite.dynamicContextText,
        ),
      };
    }
    requestEnvelope = {
      ...requestEnvelope,
      messages: nextMessages,
    };
    syncOpenClawPayloadFromEnvelope(payload, requestEnvelope, payloadCodec);
    if (dynamicContextTarget === "developer" && rootPromptRewrite.dynamicContextText) {
      const inserted = helpers.insertDeveloperDynamicContextBlock(
        payload?.input,
        rootPromptRewrite.dynamicContextText,
        devAndUser.developerIndex,
      );
      if (inserted.changed) {
        payload.input = inserted.input;
        requestEnvelope = payloadCodec.decodeRequest(payload);
      }
    }
  }
  const stableRewrite = stabilizerEnabled
    ? helpers.rewritePayloadForStablePrefix(payload, model, {
      dynamicContextTarget,
      developerTextForKeyOverride: developerCanonicalText,
    })
    : {
      promptCacheKey: typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0
        ? String(payload.prompt_cache_key)
        : "",
      userContentRewrites: 0,
      senderMetadataBlocksBefore: 0,
      senderMetadataBlocksAfter: 0,
    };
  requestEnvelope = payloadCodec.decodeRequest(payload);
  requestEnvelope = {
    ...requestEnvelope,
    metadata: {
      ...(requestEnvelope.metadata ?? {}),
      promptCacheKey: String(stableRewrite.promptCacheKey ?? ""),
    },
  };
  const memoryInjection = !proxyPureForward
    ? await injectProceduralMemoryHints({
      cfg,
      sessionId: resolvedSessionId,
      payload,
      helpers,
    })
    : { injected: false, hitCount: 0 };
  if (stabilizerEnabled && cfg.stateDir) {
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "stable_prefix_rewrite",
      sessionId: resolvedSessionId,
      model,
      promptCacheKey: stableRewrite.promptCacheKey,
      inputItemCount: Array.isArray(payload?.input) ? payload.input.length : 0,
      inputChars: helpers.estimatePayloadInputChars(payload?.input),
      userContentRewrites: stableRewrite.userContentRewrites,
      senderMetadataBlocksBefore: stableRewrite.senderMetadataBlocksBefore,
      senderMetadataBlocksAfter: stableRewrite.senderMetadataBlocksAfter,
      proceduralMemoryInjected: memoryInjection.injected,
      proceduralMemoryHitCount: memoryInjection.hitCount,
    });
  }
  const beforeReductionInputCount = Array.isArray(payload?.input) ? payload.input.length : 0;
  const beforeReductionInputChars = helpers.estimatePayloadInputChars(payload?.input);
  const beforeReductionCanonicalInput = helpers.serializeCanonicalInputForUx(payload?.input);
  await runPolicyBeforeReduction(
    cfg,
    logger,
    helpers,
    payload,
    resolvedSessionId,
    policyModule,
  );
  const reductionApplied = await applyProxyReduction(
    cfg,
    logger,
    helpers,
    payload,
    resolvedSessionId,
    reductionPassOptions,
    policyModule,
    proxyPureForward,
    reductionTriggerMinChars,
    reductionMaxToolChars,
  );
  if (cfg.stateDir) {
    const workspaceHint =
      typeof rootPromptRewrite?.workdir === "string" && rootPromptRewrite.workdir.trim().length > 0
        ? rootPromptRewrite.workdir.trim()
        : undefined;
    await upsertOpenClawSessionSummary(cfg.stateDir, resolvedSessionId, {
      latestModel: model || upstreamModel || "unknown",
      workspaceHint,
      reductionSavedChars: reductionApplied.savedChars,
      updatedAt: new Date().toISOString(),
    });
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "proxy_before_call_rewrite",
      sessionId: resolvedSessionId,
      model,
      proxyPureForward,
      inputItemCountBefore: beforeReductionInputCount,
      inputItemCountAfter: Array.isArray(payload?.input) ? payload.input.length : 0,
      inputCharsBefore: beforeReductionInputChars,
      inputCharsAfter: helpers.estimatePayloadInputChars(payload?.input),
      reductionChangedItems: reductionApplied.changedItems,
      reductionChangedBlocks: reductionApplied.changedBlocks,
      reductionSavedChars: reductionApplied.savedChars,
      reductionSkippedReason: reductionApplied.diagnostics?.skippedReason ?? null,
      reductionCandidates: reductionApplied.diagnostics?.candidateBlocks ?? 0,
      reductionOverThreshold: reductionApplied.diagnostics?.overThresholdBlocks ?? 0,
    });
  }
  const afterReductionInputText = helpers.extractInputText(payload?.input);
  const afterReductionCanonicalInput = helpers.serializeCanonicalInputForUx(payload?.input);
  requestEnvelope = payloadCodec.decodeRequest(payload);
  if (!proxyPureForward && cfg.modules.reduction) {
    requestEnvelope = {
      ...requestEnvelope,
      metadata: {
        ...(requestEnvelope.metadata ?? {}),
        promptCacheKey: String(stableRewrite.promptCacheKey ?? ""),
        ...(stabilizerEnabled ? { promptCacheRetention: "24h" } : {}),
      },
    };
    payload.__tokenpilot_reduction_applied = true;
  } else {
    requestEnvelope = {
      ...requestEnvelope,
      metadata: {
        ...(requestEnvelope.metadata ?? {}),
        promptCacheKey: String(stableRewrite.promptCacheKey ?? ""),
      },
    };
  }
  syncOpenClawPayloadFromEnvelope(payload, requestEnvelope, payloadCodec);
  helpers.stripInternalPayloadMarkers(payload);
  logger.info(`[plugin-runtime] proxy request model=${model || "unknown"} upstreamModel=${upstreamModel || "unknown"} instrChars=${instructions.length} cacheKey=${stableRewrite.promptCacheKey} userContentRewrites=${stableRewrite.userContentRewrites} senderBlocks=${stableRewrite.senderMetadataBlocksBefore}->${stableRewrite.senderMetadataBlocksAfter} reductionEngine=${proxyPureForward ? "proxy_pure_forward" : cfg.reduction.engine} reductionItems=${reductionApplied.changedItems} reductionBlocks=${reductionApplied.changedBlocks} reductionSavedChars=${reductionApplied.savedChars} reductionCandidates=${reductionApplied.diagnostics?.candidateBlocks ?? 0} reductionOverThreshold=${reductionApplied.diagnostics?.overThresholdBlocks ?? 0} reductionPersistedSkipped=${reductionApplied.diagnostics?.persistedSkippedItems ?? 0} reductionSkipped=${reductionApplied.diagnostics?.skippedReason ?? "none"}`);
  await recordProxyInbound({
    cfg,
    helpers,
    upstream,
    requestEnvelope,
    payload,
    resolvedSessionId,
    model,
    upstreamModel,
    instructions,
    stableRewrite,
    rootPromptRewrite,
    reductionApplied,
    developerForwardedText,
    developerCanonicalText,
    devAndUser,
    firstTurnCandidate,
    originalPromptCacheKey,
    dynamicContextTarget,
    shouldRecordStability: stabilizerEnabled && Boolean(cfg.stateDir) && Boolean(devAndUser),
  });
  if (stabilizerEnabled) payload.prompt_cache_retention = "24h";
  const cacheAuditSnapshot = buildOpenClawCacheAuditSnapshot({
    envelope: requestEnvelope,
    sessionId: resolvedSessionId,
    model: requestEnvelope.model,
    stream: requestEnvelope.stream,
    originalRequestPromptCacheKey: originalPromptCacheKey || null,
    requestPromptCacheKey:
      typeof requestEnvelope.metadata?.promptCacheKey === "string"
        ? requestEnvelope.metadata.promptCacheKey
        : null,
  });
  return {
    payload,
    requestEnvelope,
    payloadCodec,
    model,
    upstreamModel,
    originalInputText,
    afterReductionInputText,
    beforeReductionCanonicalInput,
    afterReductionCanonicalInput,
    proxyPureForward,
    reductionTriggerMinChars,
    reductionMaxToolChars,
    resolvedSessionId,
    instructions,
    stableRewrite,
    rootPromptRewrite,
    reductionApplied,
    developerForwardedText,
    developerCanonicalText,
    devAndUser,
    firstTurnCandidate,
    originalPromptCacheKey,
    reductionPassOptions,
    cacheAuditSnapshot,
  };
}
