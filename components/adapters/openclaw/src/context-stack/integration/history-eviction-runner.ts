import type { CanonicalTranscriptState } from "@lightmem2/history";
import type { HistoryEvictionResult } from "@tokenpilot/eviction";

export type { HistoryEvictionResult } from "@tokenpilot/eviction";

export async function runHistoryEvictionIfEnabled(params: {
  cfg: any;
  sessionId: string;
  state: CanonicalTranscriptState;
  helpers: any;
  logger: any;
  rewriteCanonicalState(args: any): Promise<{
    state: CanonicalTranscriptState;
    changed: boolean;
    appliedEvictionTaskIds: string[];
  }>;
  estimateMessagesChars(messages: any[], contentToText: (value: unknown) => string): number;
}): Promise<HistoryEvictionResult> {
  const beforeChars = params.estimateMessagesChars(params.state.messages, params.helpers.contentToText);
  const enabled = Boolean(params.cfg.moduleEnablement.eviction);
  if (!enabled) {
    return {
      state: params.state,
      enabled: false,
      changed: false,
      appliedTaskIds: [],
      savedChars: 0,
      diagnostics: {
        beforeMessageCount: params.state.messages.length,
        afterMessageCount: params.state.messages.length,
        beforeChars,
        afterChars: beforeChars,
        skippedReason: "module_disabled",
      },
    };
  }

  const rewritten = await params.rewriteCanonicalState({
    stateDir: params.cfg.stateDir,
    sessionId: params.sessionId,
    state: params.state,
    evictionEnabled: true,
    evictionPolicy: params.cfg.eviction.policy,
    evictionMinBlockChars: params.cfg.eviction.minBlockChars,
    evictionReplacementMode: params.cfg.eviction.replacementMode,
    helpers: {
      appendTaskStateTrace: params.helpers.appendTaskStateTrace,
      appendEvictionVisualSnapshot: params.helpers.appendEvictionVisualSnapshot,
      asRecord: params.helpers.asRecord,
      canonicalMessageTaskIds: params.helpers.canonicalMessageTaskIds,
      contentToText: params.helpers.contentToText,
      dedupeStrings: params.helpers.dedupeStrings,
      ensureContextSafeDetails: params.helpers.ensureContextSafeDetails,
      extractPathLike: params.helpers.extractPathLike,
      extractToolMessageText: params.helpers.extractToolMessageText,
      isToolResultLikeMessage: params.helpers.isToolResultLikeMessage,
      logger: params.logger,
      messageToolCallId: params.helpers.messageToolCallId,
      safeId: params.helpers.safeId,
    },
  });
  const afterChars = params.estimateMessagesChars(rewritten.state.messages, params.helpers.contentToText);
  return {
    state: rewritten.state,
    enabled: true,
    changed: rewritten.changed,
    appliedTaskIds: rewritten.appliedEvictionTaskIds,
    savedChars: Math.max(0, beforeChars - afterChars),
    diagnostics: {
      beforeMessageCount: params.state.messages.length,
      afterMessageCount: rewritten.state.messages.length,
      beforeChars,
      afterChars,
    },
  };
}
