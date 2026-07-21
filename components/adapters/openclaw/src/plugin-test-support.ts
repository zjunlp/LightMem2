/* eslint-disable @typescript-eslint/no-explicit-any */
import { createPolicyModule } from "@lightmem2/tokenpilot";
import {
  estimatePayloadInputChars,
  extractInputText,
  findDeveloperAndPrimaryUser,
  findRootPromptCandidate,
  insertDeveloperDynamicContextBlock,
  normalizeText,
  rewritePayloadForStablePrefix,
} from "./context-stack/request-preprocessing/stable-prefix.js";
import { applyProxyReductionToInput } from "./context-stack/request-preprocessing/before-call-reduction.js";
import {
  applyLayeredReductionAfterCall,
  applyLayeredReductionAfterCallToSse,
} from "./context-stack/request-preprocessing/after-call-reduction.js";
import { buildLayeredReductionContext } from "./context-stack/request-preprocessing/reduction-context.js";
import {
  prependTextToContent,
  rewriteRootPromptForStablePrefix,
} from "./context-stack/request-preprocessing/root-prompt-stabilizer.js";
import {
  inferObservationPayloadKind,
  syncRawSemanticTurnsFromTranscript,
} from "./context-stack/page-out/transcript-sync.js";
import {
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  injectMemoryFaultProtocolInstructions,
  stripInternalPayloadMarkers,
} from "./context-stack/page-in-api.js";
import {
  buildPolicyModuleConfigFromPluginConfig,
  applyPolicyBeforeCall,
} from "./context-stack/integration/policy-config-bridge.js";
import { asRecord } from "./context-stack/integration/config-types.js";
import { contentToText, extractProviderResponseText } from "./context-stack/integration/runtime-event-text.js";
import { dedupeStrings } from "./context-stack/integration/runtime-tooling.js";
import { makeLogger } from "./context-stack/integration/runtime-helpers.js";
import { detectUpstreamConfig, normalizeProxyModelId } from "./context-stack/integration/upstream-config.js";
import { requestUpstreamResponses, requestUpstreamResponsesStream } from "./context-stack/integration/upstream-transport.js";
import { responsesPayloadToChatCompletions, chatCompletionsToResponsesText } from "./context-stack/integration/upstream-adapter.js";
import { convertChatCompletionsSseToResponsesSse, isSseContentType } from "./context-stack/integration/upstream-sse.js";
import { normalizeConfig } from "./context-stack/integration/config-normalize.js";
import { prepareProxyRequest } from "./context-stack/integration/proxy-runtime-request.js";
import { recordStreamingUxEffect } from "./context-stack/integration/proxy-runtime-stream.js";
import { countTokensWithFallback, recordUxEffect, serializeCanonicalInputForUx } from "./context-stack/integration/ux-effects.js";
import {
  createOpenClawPayloadCodec,
  createOpenClawSessionResolver,
} from "./context-stack/integration/openclaw-host-adapter.js";
import { isReductionPassEnabled } from "@lightmem2/reduction";
import { loadOrderedTurnAnchors, loadSegmentAnchorByCallId } from "@lightmem2/history";
import {
  appendJsonl,
  appendForwardedInputDump,
  appendReductionPassTrace,
  appendTaskStateTrace,
} from "./trace/io.js";
import { contextSafeRecovery as importedContextSafeRecovery, hasRecoveryMarker as importedHasRecoveryMarker } from "./context-stack/page-in-api.js";
import {
  appendEvictionVisualSnapshot,
  appendReductionVisualSnapshot,
  appendStabilityVisualSnapshot,
  readVisualSessionData,
  readVisualSessionList,
} from "@lightmem2/product-surface";

export const TEST_WORKSPACE_DIR = "/tmp/tokenpilot-openclaw-plugin-tests";

function contextSafeRecovery(details: unknown): Record<string, unknown> | undefined {
  return importedContextSafeRecovery(details, asRecord);
}

function hasRecoveryMarker(details: unknown): boolean {
  return importedHasRecoveryMarker(details, asRecord);
}

export const proxyRuntimeHelpers = {
  detectUpstreamConfig,
  createPolicyModule,
  buildPolicyModuleConfigFromPluginConfig,
  normalizeProxyModelId,
  injectMemoryFaultProtocolInstructions,
  normalizeText,
  findDeveloperAndPrimaryUser,
  findRootPromptCandidate,
  rewriteRootPromptForStablePrefix,
  prependTextToContent,
  rewritePayloadForStablePrefix,
  insertDeveloperDynamicContextBlock,
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
  extractProviderResponseText,
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
  requestUpstreamResponsesStream,
  applyLayeredReductionAfterCall,
  applyLayeredReductionAfterCallToSse,
  convertChatCompletionsSseToResponsesSse,
  isSseContentType,
  countTokensWithFallback,
  recordUxEffect,
  serializeCanonicalInputForUx,
  createOpenClawPayloadCodec,
  createOpenClawSessionResolver,
};

const defaultBeforeCallTestHelpers = {
  applyPolicyBeforeCall,
  buildLayeredReductionContext: (
    payload: any,
    triggerMinChars: number,
    sessionId: string,
    passToggles: any,
    passOptions: any,
    segmentAnchorByCallId: any,
    orderedTurnAnchors: any,
  ) => withTestWorkspaceDir(
    buildLayeredReductionContext(
      payload,
      triggerMinChars,
      sessionId,
      {
        memoryFaultRecoverToolName: MEMORY_FAULT_RECOVER_TOOL_NAME,
        hasRecoveryMarker,
        inferObservationPayloadKind,
      },
      passToggles,
      passOptions,
      segmentAnchorByCallId,
      orderedTurnAnchors,
    ),
  ),
  isReductionPassEnabled,
  loadOrderedTurnAnchors: (stateDir: string, sessionId: string) =>
    loadOrderedTurnAnchors(stateDir, sessionId, dedupeStrings),
  loadSegmentAnchorByCallId: (stateDir: string, sessionId: string) =>
    loadSegmentAnchorByCallId(stateDir, sessionId, {
      dedupeStrings,
      syncRawSemanticTurnsFromTranscript: async (dir: string, sid: string) => {
        await syncRawSemanticTurnsFromTranscript(dir, sid, {
          contentToText,
          contextSafeRecovery,
          memoryFaultRecoverToolName: MEMORY_FAULT_RECOVER_TOOL_NAME,
        });
      },
    }),
  makeLogger: () => makeLogger(),
};

function withTestReductionConfig(
  options?: {
    sessionId?: string;
    engine?: "layered";
    logger?: any;
    triggerMinChars?: number;
    maxToolChars?: number;
    passToggles?: Record<string, unknown>;
    passOptions?: Record<string, Record<string, unknown>>;
    beforeCallModules?: {
      policy?: any;
      eviction?: any;
    };
    cfg?: any;
  },
): {
  sessionId?: string;
  engine?: "layered";
  logger?: any;
  triggerMinChars?: number;
  maxToolChars?: number;
  passToggles?: Record<string, unknown>;
  passOptions?: Record<string, Record<string, unknown>>;
  beforeCallModules?: {
    policy?: any;
    eviction?: any;
  };
  cfg?: any;
} | undefined {
  if (!options) {
    return { cfg: { stateDir: TEST_WORKSPACE_DIR } };
  }
  return {
    ...options,
    cfg: {
      ...(options.cfg ?? {}),
      stateDir: options.cfg?.stateDir ?? TEST_WORKSPACE_DIR,
    },
  };
}

function withTestWorkspaceDir(result: ReturnType<typeof buildLayeredReductionContext>): ReturnType<typeof buildLayeredReductionContext> {
  return {
    ...result,
    turnCtx: {
      ...result.turnCtx,
      metadata: {
        ...(result.turnCtx.metadata ?? {}),
        workspaceDir:
          typeof result.turnCtx.metadata?.workspaceDir === "string"
            ? result.turnCtx.metadata.workspaceDir
            : TEST_WORKSPACE_DIR,
      },
    },
  };
}

export const __testHooks = {
  rewritePayloadForStablePrefix,
  insertDeveloperDynamicContextBlock,
  applyProxyReductionToInput: (
    payload: any,
    options?: {
      sessionId?: string;
      engine?: "layered";
      logger?: any;
      triggerMinChars?: number;
      maxToolChars?: number;
      passToggles?: Record<string, unknown>;
      passOptions?: Record<string, Record<string, unknown>>;
      beforeCallModules?: {
        policy?: any;
        eviction?: any;
      };
      cfg?: any;
    },
  ) => applyProxyReductionToInput(
    payload,
    withTestReductionConfig(options),
    defaultBeforeCallTestHelpers,
  ),
  stripInternalPayloadMarkers,
  normalizeConfig,
  responsesPayloadToChatCompletions,
  chatCompletionsToResponsesText,
  convertChatCompletionsSseToResponsesSse,
  prepareProxyRequest: (args: {
    cfg: any;
    logger?: any;
    helpers?: any;
    payload: any;
    upstream?: any;
    resolveSessionIdForPayload?: ((payload: any) => string | undefined) | undefined;
    policyModule?: any;
    reductionPassOptions?: any;
    dynamicContextTarget?: "user" | "developer";
  }) => prepareProxyRequest({
    cfg: {
      stateDir: TEST_WORKSPACE_DIR,
      ...(args.cfg ?? {}),
    },
    logger: args.logger ?? makeLogger(),
    helpers: {
      ...proxyRuntimeHelpers,
      ...(args.helpers ?? {}),
    },
    payload: args.payload,
    upstream: args.upstream ?? {
      providerId: "test-upstream",
      baseUrl: "http://127.0.0.1:9999/v1",
      models: [{ id: "gpt-5.4-mini" }],
    },
    resolveSessionIdForPayload: args.resolveSessionIdForPayload,
    policyModule: args.policyModule,
    reductionPassOptions: args.reductionPassOptions ?? {},
    dynamicContextTarget: args.dynamicContextTarget ?? "developer",
  }),
  recordStreamingUxEffect,
  applyLayeredReductionAfterCall,
  applyLayeredReductionAfterCallToSse,
  appendStabilityVisualSnapshot,
  appendReductionVisualSnapshot,
  appendEvictionVisualSnapshot,
  readVisualSessionData,
  readVisualSessionList,
  createOpenClawPayloadCodec,
  createOpenClawSessionResolver,
};

export { contextSafeRecovery, hasRecoveryMarker };
