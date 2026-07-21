/* eslint-disable @typescript-eslint/no-explicit-any */
import { applyToolResultPersistPolicy } from "./context-stack/request-preprocessing/tool-results-persist-policy.js";

export function registerToolCallHooks(params: {
  api: any;
  cfg: any;
  hookOn: (api: any, event: string, handler: (...args: any[]) => any) => void;
  appendTaskStateTrace: (stateDir: string, payload: Record<string, unknown>) => Promise<void>;
  maybeBlockRepeatedToolCall: (event: any, cfg: any, deps: any) => Promise<string | undefined>;
  applyBeforeToolCallDefaults: (event: any) => Record<string, unknown>;
  applyWorkspacePathHintToToolParams: (event: any, workspaceDir?: string) => Record<string, unknown> | undefined;
  resolveWorkspaceHintForEvent: (event: any) => string | undefined;
  recordToolCallMemo: (event: any, cfg: any, deps: any) => Promise<void>;
  safeId: (value: string) => string;
  logger: any;
}): void {
  const {
    api,
    cfg,
    hookOn,
    appendTaskStateTrace,
    maybeBlockRepeatedToolCall,
    applyBeforeToolCallDefaults,
    applyWorkspacePathHintToToolParams,
    resolveWorkspaceHintForEvent,
    recordToolCallMemo,
    safeId,
    logger,
  } = params;
  if (!cfg.hooks.beforeToolCall) return;

  hookOn(api, "before_tool_call", async (event: any) => {
    const blockReason = await maybeBlockRepeatedToolCall(event, cfg, {
      appendTaskStateTrace,
    });
    if (blockReason) {
      return { block: true, blockReason };
    }
    const withDefaults = applyBeforeToolCallDefaults(event);
    const withWorkspaceHint = applyWorkspacePathHintToToolParams(
      { ...event, params: withDefaults },
      resolveWorkspaceHintForEvent(event),
    );
    return { params: withWorkspaceHint ?? withDefaults };
  });

  hookOn(api, "after_tool_call", (event: any) => {
    void recordToolCallMemo(event, cfg, {
      safeId,
      appendTaskStateTrace,
      logger,
    });
  });
}

export function registerToolResultPersistHook(params: {
  api: any;
  cfg: any;
  hookOn: (api: any, event: string, handler: (...args: any[]) => any) => void;
  logger: any;
  appendTaskStateTrace: (stateDir: string, payload: Record<string, unknown>) => Promise<void>;
  ensureContextSafeDetails: (details: unknown, patch: Record<string, unknown>) => Record<string, unknown>;
  extractOpenClawSessionId: (event: any) => string;
  extractToolMessageText: (message: Record<string, unknown>) => string;
  isToolResultLikeMessage: (message: Record<string, unknown>) => boolean;
  safeId: (value: string) => string;
}): void {
  const {
    api,
    cfg,
    hookOn,
    logger,
    appendTaskStateTrace,
    ensureContextSafeDetails,
    extractOpenClawSessionId,
    extractToolMessageText,
    isToolResultLikeMessage,
    safeId,
  } = params;
  if (!cfg.hooks.toolResultPersist) return;

  hookOn(api, "tool_result_persist", (event: any) => {
    const out = applyToolResultPersistPolicy(event, cfg, logger, {
      appendTaskStateTrace,
      ensureContextSafeDetails,
      extractOpenClawSessionId,
      extractToolMessageText,
      isToolResultLikeMessage,
      safeId,
    });
    return out ?? { message: event?.message };
  });
}

export function registerLayeredContextEngine(params: {
  api: any;
  cfg: any;
  logger: any;
  createPluginContextEngine: (cfg: any, logger: any, deps: any) => any;
  appendTaskStateTrace: (stateDir: string, payload: Record<string, unknown>) => Promise<void>;
  appendEvictionVisualSnapshot?: (payload: {
    at: string;
    sessionId: string;
    taskId: string;
    taskLabel?: string;
    replacementMode: "pointer_stub" | "drop";
    beforeText: string;
    afterText: string;
    beforeChars: number;
    afterChars: number;
    archivePath: string;
    dataKey: string;
    turnAbsIds: string[];
  }) => Promise<void>;
  readTranscriptEntriesForSession: (sessionId: string) => Promise<any[] | null>;
  transcriptMessageStableId: (row: any) => string;
  asRecord: (value: unknown) => Record<string, unknown> | undefined;
  canonicalMessageTaskIds: (message: Record<string, unknown>, asRecord: (value: unknown) => Record<string, unknown> | undefined) => string[];
  contentToText: (value: unknown) => string;
  dedupeStrings: (values: string[]) => string[];
  ensureContextSafeDetails: (details: unknown, patch: Record<string, unknown>) => Record<string, unknown>;
  extractPathLike: (value: any) => string | undefined;
  extractToolMessageText: (message: Record<string, unknown>) => string;
  isToolResultLikeMessage: (message: Record<string, unknown>) => boolean;
  messageToolCallId: (message: Record<string, unknown>) => string | undefined;
  safeId: (value: string) => string;
}): void {
  const {
    api,
    cfg,
    logger,
    createPluginContextEngine,
    appendTaskStateTrace,
    appendEvictionVisualSnapshot,
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
  } = params;
  if (!cfg.contextEngine.enabled) return;

  if (typeof api.registerContextEngine === "function") {
    api.registerContextEngine("layered-context", () => createPluginContextEngine(cfg, logger, {
      appendTaskStateTrace,
      appendEvictionVisualSnapshot,
      readTranscriptEntriesForSession,
      transcriptMessageStableId,
      asRecord,
      canonicalMessageTaskIds: (message: Record<string, unknown>) => canonicalMessageTaskIds(message, asRecord),
      contentToText,
      dedupeStrings,
      ensureContextSafeDetails,
      extractPathLike,
      extractToolMessageText,
      isToolResultLikeMessage,
      messageToolCallId,
      safeId,
    }));
    return;
  }

  logger.warn("[plugin-runtime] registerContextEngine unavailable in this OpenClaw version.");
}
