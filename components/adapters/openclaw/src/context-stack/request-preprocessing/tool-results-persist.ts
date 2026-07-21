import {
  planToolResultPersistence,
} from "@lightmem2/artifact-store";

type PersistHelpers = {
  appendTaskStateTrace: (stateDir: string, payload: Record<string, unknown>) => Promise<void>;
  ensureContextSafeDetails: (details: unknown, patch: Record<string, unknown>) => Record<string, unknown>;
  extractOpenClawSessionId: (event: any) => string;
  extractToolMessageText: (message: Record<string, unknown>) => string;
  isToolResultLikeMessage: (message: Record<string, unknown>) => boolean;
  safeId: (value: string) => string;
};

export function applyToolResultPersistPolicy(
  event: any,
  cfg: { stateDir: string },
  logger: { warn: (message: string) => void },
  helpers: PersistHelpers,
): { message: Record<string, unknown> } | undefined {
  const message = event?.message;
  if (!message || typeof message !== "object") return undefined;
  const rawMessage = message as Record<string, unknown>;
  if (!helpers.isToolResultLikeMessage(rawMessage)) return { message: rawMessage };

  const text = helpers.extractToolMessageText(rawMessage);
  const resolvedSessionId =
    helpers.extractOpenClawSessionId(event)
    || String(event?.sessionId ?? event?.session_id ?? "").trim()
    || "proxy-session";
  const outcome = planToolResultPersistence({
    event,
    text,
    stateDir: cfg.stateDir,
    safeId: helpers.safeId,
    sessionId: resolvedSessionId,
  });
  if (outcome.resultMode === "inline") {
    return {
      message: {
        ...rawMessage,
        details: helpers.ensureContextSafeDetails(rawMessage.details, {
          resultMode: outcome.resultMode,
        }),
      },
    };
  }

  if (cfg.stateDir) {
    void helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "tool_result_persist_applied",
      sessionId: resolvedSessionId,
      toolName: outcome.toolName || "tool",
      toolCallId: String(event?.toolCallId ?? event?.tool_call_id ?? "").trim() || null,
      originalChars: outcome.originalChars,
      inlineLimit: outcome.inlineLimit,
      persisted: Boolean(outcome.outputFile),
      outputFile: outcome.outputFile ?? null,
      dataKey: outcome.dataKey ?? null,
    });
  }

  return {
    message: {
      ...rawMessage,
      content: [{
        type: "text",
        text: `${outcome.noticeText}\n\n${outcome.previewText}${outcome.recoveryHint}`,
      }],
      details: helpers.ensureContextSafeDetails(rawMessage.details, {
        resultMode: outcome.resultMode,
        excludedFromContext: true,
        outputFile: outcome.outputFile,
        dataKey: outcome.dataKey,
        originalChars: outcome.originalChars,
        previewChars: outcome.inlineLimit,
        sourcePass: outcome.sourcePass,
        persistedBy: outcome.persistedBy,
      }),
    },
  };
}
