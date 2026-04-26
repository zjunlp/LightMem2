/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  archiveContent,
  buildRecoveryHint,
} from "../execution/archive-recovery/index.js";

function buildToolResultPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[ecoclaw preview truncated]`;
}

function toolInlineLimit(toolName: string): number {
  if (toolName === "read") return 12_000;
  if (toolName === "exec" || toolName === "bash" || toolName === "web_fetch") return 4_000;
  return 8_000;
}

function resolveToolNameFromPersistEvent(event: any): string {
  return String(
    event?.toolName ??
      event?.tool_name ??
      event?.message?.toolName ??
      event?.message?.tool_name ??
      "",
  ).trim().toLowerCase();
}

type PersistHelpers = {
  appendTaskStateTrace: (stateDir: string, payload: Record<string, unknown>) => Promise<void>;
  ensureContextSafeDetails: (details: unknown, patch: Record<string, unknown>) => Record<string, unknown>;
  extractToolMessageText: (message: Record<string, unknown>) => string;
  isToolResultLikeMessage: (message: Record<string, unknown>) => boolean;
  safeId: (value: string) => string;
};

export async function applyToolResultPersistPolicy(
  event: any,
  cfg: { stateDir: string },
  logger: { warn: (message: string) => void },
  helpers: PersistHelpers,
): Promise<{ message: Record<string, unknown> } | undefined> {
  const message = event?.message;
  if (!message || typeof message !== "object") return undefined;
  const rawMessage = message as Record<string, unknown>;
  if (!helpers.isToolResultLikeMessage(rawMessage)) return { message: rawMessage };

  const toolName = resolveToolNameFromPersistEvent(event);
  const text = helpers.extractToolMessageText(rawMessage);
  const limit = toolInlineLimit(toolName);
  if (text.length <= limit) {
    return {
      message: {
        ...rawMessage,
        details: helpers.ensureContextSafeDetails(rawMessage.details, {
          resultMode: "inline",
        }),
      },
    };
  }

  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const callId = String(event?.toolCallId ?? event?.tool_call_id ?? "").trim();
  const toolPart = helpers.safeId(toolName || "tool");
  const dataKey = `tool_result_persist:${toolPart}:${callId ? helpers.safeId(callId) : digest}`;

  let outputFile: string | undefined;
  try {
    const archived = await archiveContent({
      sessionId: "proxy-session",
      segmentId: callId || `${toolPart}-${digest}`,
      sourcePass: "tool_result_persist",
      toolName: toolName || "tool",
      dataKey,
      originalText: text,
      archiveDir: join(cfg.stateDir, "ecoclaw", "artifacts", toolPart),
      metadata: {
        toolCallId: callId || undefined,
        persistedBy: "ecoclaw.tool_result_persist",
      },
    });
    outputFile = archived.archivePath;
  } catch (err) {
    logger.warn(`[plugin-runtime] tool_result_persist artifact write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const preview = buildToolResultPreview(text, limit);
  const notice = outputFile
    ? `[ecoclaw persisted tool_result] full output moved to: ${outputFile}`
    : "[ecoclaw persisted tool_result] artifact write failed, using inline preview fallback";
  const recoveryHint = outputFile
    ? buildRecoveryHint({
      dataKey,
      originalSize: text.length,
      archivePath: outputFile,
      sourceLabel: "tool_result_persist",
    })
    : "";

  if (cfg.stateDir) {
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "tool_result_persist_applied",
      sessionId: String(event?.sessionId ?? event?.session_id ?? "proxy-session"),
      toolName: toolName || "tool",
      toolCallId: callId || null,
      originalChars: text.length,
      inlineLimit: limit,
      persisted: Boolean(outputFile),
      outputFile: outputFile ?? null,
      dataKey,
    });
  }

  return {
    message: {
      ...rawMessage,
      content: `${notice}\n\n${preview}${recoveryHint}`,
      details: helpers.ensureContextSafeDetails(rawMessage.details, {
        resultMode: outputFile ? "artifact" : "inline-fallback",
        excludedFromContext: true,
        outputFile,
        dataKey,
        originalChars: text.length,
        previewChars: limit,
        sourcePass: "tool_result_persist",
        persistedBy: "ecoclaw.tool_result_persist",
      }),
    },
  };
}
