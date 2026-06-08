/* eslint-disable @typescript-eslint/no-explicit-any */
import { injectProceduralMemoryHints } from "./procedural-memory.js";
import type { UpstreamConfig } from "./upstream.js";
import { normalizeResponsesInputForUpstream } from "./proxy-runtime-shared.js";
import { recordProxyInbound } from "./proxy-runtime-logging.js";

type ProxyRequestPreparation = {
  payload: any;
  model: string;
  upstreamModel: string;
  originalInputText: string;
  afterReductionInputText: string;
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
  if (proxyPureForward || !cfg.modules.reduction) {
    return buildReductionSkippedResult(
      payload,
      reductionTriggerMinChars,
      reductionMaxToolChars,
      proxyPureForward ? "proxy_pure_forward" : "module_disabled",
    );
  }
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
        repeated_read_dedup: reductionPassOptions.repeatedReadDedup ?? {},
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
        policy: policyModule,
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
  const originalInputText = helpers.extractInputText(payload?.input);
  const model = String(payload?.model ?? "");
  const upstreamModel = helpers.normalizeProxyModelId(model);
  if (upstreamModel && upstreamModel !== model) {
    payload.model = upstreamModel;
  }
  const proxyPureForward = cfg.proxyMode.pureForward;
  const reductionTriggerMinChars = Math.max(256, cfg.reduction.triggerMinChars ?? 2200);
  const reductionMaxToolChars = Math.max(256, cfg.reduction.maxToolChars ?? 1200);
  const resolvedSessionId = String(resolveSessionIdForPayload?.(payload) ?? "proxy-session").trim() || "proxy-session";
  if (!proxyPureForward && cfg.modules.reduction) {
    helpers.injectMemoryFaultProtocolInstructions(payload);
  }
  const instructions = helpers.normalizeText(String(payload?.instructions ?? ""));
  const devAndUser = !proxyPureForward ? helpers.findDeveloperAndPrimaryUser(payload?.input) : null;
  const firstTurnCandidate = Boolean(devAndUser);
  const rootPromptRewrite = devAndUser && !proxyPureForward
    ? helpers.rewriteRootPromptForStablePrefix(devAndUser.developerText)
    : null;
  const developerCanonicalText = helpers.normalizeText(rootPromptRewrite?.canonicalPromptText ?? devAndUser?.developerText ?? "");
  const developerForwardedText = helpers.normalizeText(rootPromptRewrite?.forwardedPromptText ?? devAndUser?.developerText ?? "");
  const originalPromptCacheKey = typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0
    ? String(payload.prompt_cache_key)
    : "";
  if (!proxyPureForward && devAndUser && rootPromptRewrite && Array.isArray(payload?.input) && devAndUser.developerIndex >= 0) {
    const forwardedDeveloperText =
      dynamicContextTarget === "developer" && rootPromptRewrite.dynamicContextText
        ? `${helpers.normalizeText(rootPromptRewrite.forwardedPromptText)}\n\n${helpers.normalizeText(rootPromptRewrite.dynamicContextText)}`
        : rootPromptRewrite.forwardedPromptText;
    payload.input[devAndUser.developerIndex] = {
      ...(devAndUser.developerItem ?? payload.input[devAndUser.developerIndex]),
      role: "developer",
      content: forwardedDeveloperText,
    };
    if (dynamicContextTarget === "user" && rootPromptRewrite.dynamicContextText && devAndUser.userIndex >= 0) {
      payload.input[devAndUser.userIndex] = {
        ...(devAndUser.userItem ?? payload.input[devAndUser.userIndex]),
        role: "user",
        content: helpers.prependTextToContent(
          (devAndUser.userItem ?? payload.input[devAndUser.userIndex])?.content,
          rootPromptRewrite.dynamicContextText,
        ),
      };
    }
  }
  const stableRewrite = !proxyPureForward
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
  const memoryInjection = !proxyPureForward
    ? await injectProceduralMemoryHints({
      cfg,
      sessionId: resolvedSessionId,
      payload,
      helpers,
    })
    : { injected: false, hitCount: 0 };
  if (!proxyPureForward && cfg.stateDir) {
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
  if (!proxyPureForward && cfg.modules.reduction) {
    payload.__ecoclaw_reduction_applied = true;
  }
  helpers.stripInternalPayloadMarkers(payload);
  logger.info(`[plugin-runtime] proxy request model=${model || "unknown"} upstreamModel=${upstreamModel || "unknown"} instrChars=${instructions.length} cacheKey=${stableRewrite.promptCacheKey} userContentRewrites=${stableRewrite.userContentRewrites} senderBlocks=${stableRewrite.senderMetadataBlocksBefore}->${stableRewrite.senderMetadataBlocksAfter} reductionEngine=${proxyPureForward ? "proxy_pure_forward" : cfg.reduction.engine} reductionItems=${reductionApplied.changedItems} reductionBlocks=${reductionApplied.changedBlocks} reductionSavedChars=${reductionApplied.savedChars} reductionCandidates=${reductionApplied.diagnostics?.candidateBlocks ?? 0} reductionOverThreshold=${reductionApplied.diagnostics?.overThresholdBlocks ?? 0} reductionPersistedSkipped=${reductionApplied.diagnostics?.persistedSkippedItems ?? 0} reductionSkipped=${reductionApplied.diagnostics?.skippedReason ?? "none"}`);
  await recordProxyInbound({
    cfg,
    helpers,
    upstream,
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
  });
  payload.prompt_cache_retention = "24h";
  return {
    payload,
    model,
    upstreamModel,
    originalInputText,
    afterReductionInputText,
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
  };
}
