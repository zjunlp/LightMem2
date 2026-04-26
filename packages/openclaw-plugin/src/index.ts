/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  resolveReductionPasses as resolveLayerReductionPasses,
  runReductionBeforeCall as runLayerReductionBeforeCall,
  runReductionAfterCall as runLayerReductionAfterCall,
} from "./execution/reduction/pipeline.js";
import {
  archiveContent,
  buildRecoveryHint,
} from "./execution/archive-recovery/index.js";
import { createPolicyModule } from "../../layers/decision/src/policy.js";
import {
  prependTextToContent,
  type RootPromptRewrite,
  rewriteRootPromptForStablePrefix,
} from "./root-prompt-stabilizer.js";
import {
  applyLayeredReductionAfterCall,
  applyLayeredReductionAfterCallToSse,
  isSseContentType,
  type ProxyAfterCallReductionResult,
} from "./proxy/after-call-reduction.js";
import {
  applyProxyReductionToInput,
  type ProxyReductionResult,
} from "./proxy/before-call-reduction.js";
import { buildLayeredReductionContext } from "./proxy/reduction-context.js";
import {
  isReductionPassEnabled,
  loadOrderedTurnAnchors,
  loadSegmentAnchorByCallId,
} from "./proxy/reduction-helpers.js";
import {
  estimatePayloadInputChars,
  extractInputText,
  findDeveloperAndPrimaryUser,
  normalizeText,
  normalizeTurnBindingMessage,
  rewritePayloadForStablePrefix,
} from "./proxy/stable-prefix.js";
import {
  detectUpstreamConfig,
  ensureExplicitProxyModelsInConfig,
  normalizeProxyModelId,
  requestUpstreamResponses,
  type UpstreamConfig,
  type UpstreamHttpResponse,
} from "./proxy/upstream.js";
import {
  appendJsonl,
  appendForwardedInputDump,
  appendReductionPassTrace,
  appendTaskStateTrace,
} from "./trace/io.js";
import { applyToolResultPersistPolicy } from "./tool-results/persist.js";
import { maybeRegisterProxyProvider } from "./proxy/provider.js";
import { registerMemoryFaultRecoverTool } from "./recovery/tool.js";
import { installLlmHookTap } from "./trace/hooks.js";
import {
  applyBeforeToolCallDefaults,
  canonicalMessageTaskIds,
  contentToText,
  dedupeStrings,
  ensureContextSafeDetails,
  extractItemText,
  extractLastUserMessage,
  extractOpenClawSessionId,
  extractSessionKey,
  extractToolMessageText,
  findLastUserItem,
  hookOn,
  isToolResultLikeMessage,
  makeLogger,
  messageToolCallId,
} from "./runtime/helpers.js";
import {
  extractTurnObservations,
  inferObservationPayloadKind,
  readTranscriptEntriesForSession,
  syncRawSemanticTurnsFromTranscript,
  transcriptMessageStableId,
} from "./transcript/sync.js";
import {
  contextSafeRecovery as importedContextSafeRecovery,
  hasRecoveryMarker as importedHasRecoveryMarker,
  MEMORY_FAULT_RECOVER_TOOL_NAME,
} from "./recovery/common.js";
import {
  PluginRuntimeConfig,
  PluginLogger,
  applyPolicyBeforeCall,
  asRecord,
  buildPolicyModuleConfigFromPluginConfig,
  extractPathLike,
  normalizeConfig,
  safeId,
} from "./config.js";
import { createPluginContextEngine } from "./context-engine.js";
import { registerRuntime } from "./runtime/register.js";
import {
  injectMemoryFaultProtocolInstructions,
  stripInternalPayloadMarkers,
} from "./recovery/protocol.js";


const proxyRuntimeHelpers = {
  detectUpstreamConfig,
  createPolicyModule,
  buildPolicyModuleConfigFromPluginConfig,
  normalizeProxyModelId,
  injectMemoryFaultProtocolInstructions,
  normalizeText,
  findDeveloperAndPrimaryUser,
  rewriteRootPromptForStablePrefix,
  prependTextToContent,
  rewritePayloadForStablePrefix,
  estimatePayloadInputChars,
  appendTaskStateTrace,
  applyProxyReductionToInput,
  applyPolicyBeforeCall,
  buildLayeredReductionContext,
  isReductionPassEnabled,
  loadOrderedTurnAnchors,
  loadSegmentAnchorByCallId,
  dedupeStrings,
  syncRawSemanticTurnsFromTranscript,
  contentToText,
  contextSafeRecovery,
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  hasRecoveryMarker,
  inferObservationPayloadKind,
  makeLogger,
  stripInternalPayloadMarkers,
  extractInputText,
  appendReductionPassTrace,
  appendJsonl,
  appendForwardedInputDump,
  requestUpstreamResponses,
  applyLayeredReductionAfterCall,
  applyLayeredReductionAfterCallToSse,
  isSseContentType,
};

function contextSafeRecovery(details: unknown): Record<string, unknown> | undefined {
  return importedContextSafeRecovery(details, asRecord);
}

function hasRecoveryMarker(details: unknown): boolean {
  return importedHasRecoveryMarker(details, asRecord);
}

const __testHooks = {
  rewritePayloadForStablePrefix,
  applyProxyReductionToInput,
  stripInternalPayloadMarkers,
  normalizeConfig,
};

module.exports = {
  id: "ecoclaw",
  name: "TokenPilot Runtime Optimizer",
  __testHooks,

  register(api: any) {
    const logger = makeLogger(api?.logger);
    const cfg = normalizeConfig(api?.pluginConfig);

    if (!cfg.enabled) {
      logger.info("[plugin-runtime] Plugin disabled by config.");
      return;
    }

    if (cfg.hooks.beforeToolCall) {
      hookOn(api, "before_tool_call", (event: any) => {
        return { params: applyBeforeToolCallDefaults(event) };
      });
    }

    if (cfg.hooks.toolResultPersist) {
      hookOn(api, "tool_result_persist", async (event: any) => {
        const out = await applyToolResultPersistPolicy(event, cfg, logger, {
          appendTaskStateTrace,
          ensureContextSafeDetails,
          extractToolMessageText,
          isToolResultLikeMessage,
          safeId,
        });
        return out ?? { message: event?.message };
      });
    }

    if (cfg.contextEngine.enabled && typeof api.registerContextEngine === "function") {
      api.registerContextEngine("ecoclaw-context", () => createPluginContextEngine(cfg, logger, {
        appendTaskStateTrace,
        readTranscriptEntriesForSession,
        transcriptMessageStableId,
        asRecord,
        canonicalMessageTaskIds,
        contentToText,
        dedupeStrings,
        ensureContextSafeDetails,
        extractPathLike,
        extractToolMessageText,
        isToolResultLikeMessage,
        messageToolCallId,
        safeId,
      }));
    } else if (cfg.contextEngine.enabled) {
      logger.warn("[plugin-runtime] registerContextEngine unavailable in this OpenClaw version.");
    }

    void registerRuntime(api, cfg, logger, {
      debugEnabled: cfg.logLevel === "debug",
      hookOn,
      safeId,
      contentToText,
      contextSafeRecovery,
      memoryFaultRecoverToolName: MEMORY_FAULT_RECOVER_TOOL_NAME,
      extractTurnObservations,
      extractSessionKey,
      extractLastUserMessage,
      extractOpenClawSessionId,
      normalizeTurnBindingMessage,
      extractItemText: (item: any) => extractItemText(item, extractInputText),
      findLastUserItem,
      syncRawSemanticTurnsFromTranscript,
      appendTaskStateTrace,
      maybeRegisterProxyProvider,
      ensureExplicitProxyModelsInConfig,
      installLlmHookTap,
      proxyRuntimeHelpers,
    });
  },
};
