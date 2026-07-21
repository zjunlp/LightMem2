/* eslint-disable @typescript-eslint/no-explicit-any */
import { runBeforeCallReductionOrchestrator } from "@tokenpilot/host-adapter";
import { appendModuleObservations } from "@tokenpilot/product-surface";
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
import {
  runLifecyclePlanningIfEnabled,
  type LifecyclePlanningResult,
} from "./lifecycle-planning-runner.js";
import { runPrefixIfEnabled } from "./prefix-runner.js";
import { runRequestModules, type ModuleExecutionRecord } from "./module-orchestrator.js";
import { TOKENPILOT_REQUEST_MODULE_IDS } from "@tokenpilot/decision";

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
  lifecycleRun: LifecyclePlanningResult;
  requestModuleExecutions: ModuleExecutionRecord[];
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

async function runReductionIfEnabled(
  cfg: any,
  logger: any,
  helpers: any,
  payload: any,
  resolvedSessionId: string,
  reductionPassOptions: any,
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
    reductionEnabled: cfg.moduleEnablement.reduction,
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
  const stabilizerEnabled = !proxyPureForward && cfg.moduleEnablement.stabilizer;
  const reductionTriggerMinChars = Math.max(256, cfg.reduction.triggerMinChars ?? 2200);
  const reductionMaxToolChars = Math.max(256, cfg.reduction.maxToolChars ?? 1200);
  const reductionEnabled = !proxyPureForward && cfg.moduleEnablement.reduction;
  const resolvedSessionId = String(requestEnvelope.session.sessionId ?? "proxy-session").trim() || "proxy-session";
  if (reductionEnabled) {
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
  const requestModuleContext: {
    prefixRun: ReturnType<typeof runPrefixIfEnabled>;
    memoryInjection: { injected: boolean; hitCount: number };
    beforeReductionInputCount: number;
    beforeReductionInputChars: number;
    beforeReductionCanonicalInput: string;
    lifecycleRun: LifecyclePlanningResult;
    reductionApplied: any;
  } = {
    prefixRun: runPrefixIfEnabled({
      enabled: false,
      payload,
      requestEnvelope,
      payloadCodec,
      model,
      dynamicContextTarget,
      helpers,
    }),
    memoryInjection: { injected: false, hitCount: 0 },
    beforeReductionInputCount: 0,
    beforeReductionInputChars: 0,
    beforeReductionCanonicalInput: "",
    lifecycleRun: {
      enabled: false,
      executed: false,
      skippedReason: "module_disabled",
    },
    reductionApplied: buildReductionSkippedResult(
      payload,
      reductionTriggerMinChars,
      reductionMaxToolChars,
      proxyPureForward ? "proxy_pure_forward" : "module_disabled",
    ),
  };
  const requestModuleExecutions = await runRequestModules({
    context: requestModuleContext,
    modules: [
      {
        id: TOKENPILOT_REQUEST_MODULE_IDS.stabilizer,
        enabled: () => stabilizerEnabled,
        run: () => {
          requestModuleContext.prefixRun = runPrefixIfEnabled({
            enabled: true,
            payload,
            requestEnvelope,
            payloadCodec,
            model,
            dynamicContextTarget,
            helpers,
          });
          requestEnvelope = requestModuleContext.prefixRun.requestEnvelope;
          return requestModuleContext.prefixRun;
        },
      },
      {
        id: TOKENPILOT_REQUEST_MODULE_IDS.memoryInjection,
        enabled: () => !proxyPureForward,
        run: async () => {
          requestModuleContext.memoryInjection = await injectProceduralMemoryHints({
            cfg,
            sessionId: resolvedSessionId,
            payload,
            helpers,
          });
          return requestModuleContext.memoryInjection;
        },
      },
      {
        id: TOKENPILOT_REQUEST_MODULE_IDS.stabilizerTrace,
        enabled: () => stabilizerEnabled && Boolean(cfg.stateDir),
        run: async () => {
          const { prefixRun, memoryInjection } = requestModuleContext;
          await helpers.appendTaskStateTrace(cfg.stateDir, {
            stage: "stable_prefix_rewrite",
            sessionId: resolvedSessionId,
            model,
            promptCacheKey: prefixRun.stableRewrite.promptCacheKey,
            inputItemCount: Array.isArray(payload?.input) ? payload.input.length : 0,
            inputChars: helpers.estimatePayloadInputChars(payload?.input),
            userContentRewrites: prefixRun.stableRewrite.userContentRewrites,
            senderMetadataBlocksBefore: prefixRun.stableRewrite.senderMetadataBlocksBefore,
            senderMetadataBlocksAfter: prefixRun.stableRewrite.senderMetadataBlocksAfter,
            proceduralMemoryInjected: memoryInjection.injected,
            proceduralMemoryHitCount: memoryInjection.hitCount,
          });
        },
      },
      {
        id: TOKENPILOT_REQUEST_MODULE_IDS.reductionSnapshot,
        enabled: () => true,
        run: () => {
          requestModuleContext.beforeReductionInputCount = Array.isArray(payload?.input)
            ? payload.input.length
            : 0;
          requestModuleContext.beforeReductionInputChars = helpers.estimatePayloadInputChars(payload?.input);
          requestModuleContext.beforeReductionCanonicalInput = helpers.serializeCanonicalInputForUx(payload?.input);
        },
      },
      {
        id: TOKENPILOT_REQUEST_MODULE_IDS.lifecyclePlanning,
        enabled: () => cfg.moduleEnablement.eviction,
        run: async () => {
          requestModuleContext.lifecycleRun = await runLifecyclePlanningIfEnabled({
            cfg,
            logger,
            payload,
            sessionId: resolvedSessionId,
            policyModule,
            extractInputText: helpers.extractInputText,
            applyPolicyBeforeCall: helpers.applyPolicyBeforeCall,
          });
          if (cfg.stateDir) {
            const policyMetadata =
              requestModuleContext.lifecycleRun.policyMetadata
              && typeof requestModuleContext.lifecycleRun.policyMetadata === "object"
                ? requestModuleContext.lifecycleRun.policyMetadata as Record<string, any>
                : undefined;
            await helpers.appendTaskStateTrace(cfg.stateDir, {
              stage: "lifecycle_planning_completed",
              sessionId: resolvedSessionId,
              enabled: requestModuleContext.lifecycleRun.enabled,
              executed: requestModuleContext.lifecycleRun.executed,
              skippedReason: requestModuleContext.lifecycleRun.skippedReason ?? null,
              registryChanged: Boolean(requestModuleContext.lifecycleRun.registryChanged),
              planCreated: Boolean(requestModuleContext.lifecycleRun.planCreated),
              plannedSavedChars: Number(requestModuleContext.lifecycleRun.plannedSavedChars ?? 0),
              plannedInstructionCount: Number(requestModuleContext.lifecycleRun.plannedInstructionCount ?? 0),
              evictionPlan: policyMetadata?.decisions?.eviction ?? null,
              taskState: policyMetadata?.decisions?.taskState ?? null,
            });
          }
          return requestModuleContext.lifecycleRun;
        },
      },
      {
        id: TOKENPILOT_REQUEST_MODULE_IDS.reduction,
        enabled: () => reductionEnabled,
        run: async () => {
          requestModuleContext.reductionApplied = await runReductionIfEnabled(
            cfg,
            logger,
            helpers,
            payload,
            resolvedSessionId,
            reductionPassOptions,
            proxyPureForward,
            reductionTriggerMinChars,
            reductionMaxToolChars,
          );
          return requestModuleContext.reductionApplied;
        },
      },
    ],
  });
  const prefixRun = requestModuleContext.prefixRun;
  requestEnvelope = prefixRun.requestEnvelope;
  const {
    memoryInjection,
    beforeReductionInputCount,
    beforeReductionInputChars,
    beforeReductionCanonicalInput,
    lifecycleRun,
    reductionApplied,
  } = requestModuleContext;
  const {
    stableRewrite,
    rootPromptRewrite,
    developerCanonicalText,
    developerForwardedText,
    devAndUser,
    firstTurnCandidate,
    originalPromptCacheKey,
  } = prefixRun;
  if (cfg.stateDir) {
    const executionById = new Map(requestModuleExecutions.map((execution) => [execution.id, execution]));
    const prefixChanged = Boolean(
      prefixRun.enabled
      && (
        prefixRun.originalPromptCacheKey !== String(prefixRun.stableRewrite.promptCacheKey ?? "")
        || Number(prefixRun.stableRewrite.userContentRewrites ?? 0) > 0
        || Number(prefixRun.stableRewrite.senderMetadataBlocksBefore ?? 0)
          !== Number(prefixRun.stableRewrite.senderMetadataBlocksAfter ?? 0)
        || prefixRun.developerCanonicalText !== prefixRun.developerForwardedText
      )
    );
    const observations = [
      {
        moduleId: "stabilizer" as const,
        enabled: stabilizerEnabled,
        executed: executionById.get("stabilizer")?.status === "executed",
        changed: prefixChanged,
        skippedReason: executionById.get("stabilizer")?.skippedReason,
        savedChars: 0,
        savedTokens: 0,
        api: { inputTokens: 0, outputTokens: 0 },
      },
      {
        moduleId: "reduction" as const,
        enabled: reductionEnabled,
        executed: executionById.get("reduction")?.status === "executed",
        changed: Number(reductionApplied.savedChars ?? 0) > 0,
        skippedReason:
          executionById.get("reduction")?.skippedReason
          ?? reductionApplied.diagnostics?.skippedReason,
        savedChars: 0,
        savedTokens: 0,
        api: { inputTokens: 0, outputTokens: 0 },
      },
      {
        moduleId: "eviction" as const,
        enabled: lifecycleRun.enabled,
        executed: lifecycleRun.executed,
        changed: false,
        skippedReason: lifecycleRun.skippedReason,
        savedChars: 0,
        savedTokens: 0,
        api: {
          inputTokens: Math.max(0, Number(lifecycleRun.estimatorUsage?.inputTokens ?? 0)),
          outputTokens: Math.max(0, Number(lifecycleRun.estimatorUsage?.outputTokens ?? 0)),
          ...(typeof lifecycleRun.estimatorUsage?.costUsd === "number"
            ? { costUsd: lifecycleRun.estimatorUsage.costUsd }
            : {}),
        },
      },
    ];
    try {
      await appendModuleObservations(
        cfg.stateDir,
        observations.map((observation) => ({
          sessionId: resolvedSessionId,
          phase: "request",
          ...observation,
        })),
      );
    } catch (error) {
      logger.warn?.(
        `[plugin-runtime] module observation write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (cfg.stateDir) {
    const workspaceHint =
      typeof rootPromptRewrite?.workdir === "string" && rootPromptRewrite.workdir.trim().length > 0
        ? rootPromptRewrite.workdir.trim()
        : undefined;
    await upsertOpenClawSessionSummary(cfg.stateDir, resolvedSessionId, {
      latestModel: model || upstreamModel || "unknown",
      workspaceHint,
      updatedAt: new Date().toISOString(),
    });
    if (reductionEnabled) {
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
  }
  const afterReductionInputText = helpers.extractInputText(payload?.input);
  const afterReductionCanonicalInput = helpers.serializeCanonicalInputForUx(payload?.input);
  requestEnvelope = payloadCodec.decodeRequest(payload);
  if (reductionEnabled) {
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
    shouldRecordReduction: reductionEnabled,
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
    lifecycleRun,
    requestModuleExecutions,
    developerForwardedText,
    developerCanonicalText,
    devAndUser,
    firstTurnCandidate,
    originalPromptCacheKey,
    reductionPassOptions,
    cacheAuditSnapshot,
  };
}
