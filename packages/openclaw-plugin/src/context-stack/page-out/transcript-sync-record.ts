/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  buildTurnAbsId,
  createTurnAnchor,
} from "../../../../layers/history/src/raw-semantic.js";
import type { RawSemanticTurnRecord } from "../../../../layers/history/src/types.js";
import { extractTurnObservations, isWriteLikeToolName } from "./transcript-observations.js";
import type { TranscriptHelpers } from "./transcript-types.js";
import { sliceMessagesForCurrentUserTurn, sliceMessagesForTurnSeq } from "./transcript-sync-slice.js";
import { dedupeStrings, summarizeText } from "./transcript-sync-utils.js";

function extractAssistantText(content: unknown, helpers: TranscriptHelpers): string {
  if (!Array.isArray(content)) return helpers.contentToText(content).trim();
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      const text = helpers.contentToText(item).trim();
      if (text) parts.push(text);
      continue;
    }
    const obj = item as Record<string, unknown>;
    const type = String(obj.type ?? "").toLowerCase();
    if (type === "toolcall" || type === "tool_call") continue;
    const text = helpers.contentToText(obj).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

function extractFileRefsFromToolArgs(args: Record<string, unknown> | undefined): {
  filesRead: string[];
  filesWritten: string[];
} {
  const candidates = [
    args?.path,
    args?.file_path,
    args?.filePath,
    args?.output,
    args?.output_path,
    args?.outputPath,
  ];
  const normalized = candidates
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const filesRead = dedupeStrings(normalized.filter((_, index) => index < 1));
  const filesWritten = dedupeStrings(normalized.filter((_, index) => index >= 1));
  return { filesRead, filesWritten };
}

function buildRawSemanticTurnRecordFromMessages(
  sessionId: string,
  turnSeq: number,
  messages: any[],
  helpers: TranscriptHelpers,
): RawSemanticTurnRecord | null {
  const scopedMessages = sliceMessagesForCurrentUserTurn(messages);
  if (scopedMessages.length === 0) return null;

  const userAnchor = createTurnAnchor(sessionId, turnSeq, "user");
  const assistantAnchor = createTurnAnchor(sessionId, turnSeq, "assistant");
  const toolAnchor = createTurnAnchor(sessionId, turnSeq, "tool");
  const rawRecord: RawSemanticTurnRecord = {
    sessionId,
    turnSeq,
    turnAbsId: buildTurnAbsId(sessionId, turnSeq),
    messages: [],
    toolCalls: [],
    toolResults: [],
  };

  for (const msg of scopedMessages) {
    const role = String(msg?.role ?? "").toLowerCase();
    if (role === "user") {
      const text = helpers.contentToText(msg?.content ?? msg?.text ?? "").trim();
      if (!text) continue;
      rawRecord.messages.push({
        anchor: userAnchor,
        role: "user",
        text,
      });
      continue;
    }
    if (role === "assistant") {
      const assistantText = extractAssistantText(msg?.content ?? msg?.text ?? "", helpers).trim();
      if (assistantText) {
        rawRecord.messages.push({
          anchor: assistantAnchor,
          role: "assistant",
          text: assistantText,
        });
      }
      const content = Array.isArray(msg?.content) ? msg.content : [];
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const type = String(obj.type ?? "").toLowerCase();
        if (type !== "toolcall" && type !== "tool_call") continue;
        const toolCallId =
          typeof obj.id === "string" && obj.id.trim().length > 0 ? obj.id.trim() : "";
        const toolName =
          typeof obj.name === "string" && obj.name.trim().length > 0 ? obj.name.trim() : "unknown";
        const args =
          obj.arguments && typeof obj.arguments === "object"
            ? (obj.arguments as Record<string, unknown>)
            : undefined;
        const argumentsText = args ? JSON.stringify(args) : undefined;
        const refs = extractFileRefsFromToolArgs(args);
        rawRecord.toolCalls.push({
          anchor: assistantAnchor,
          toolCallId: toolCallId || `toolcall-${rawRecord.toolCalls.length + 1}`,
          toolName,
          argumentsText,
          argumentsSummary: summarizeText(argumentsText ?? toolName, 400),
          ...(refs.filesRead.length > 0 ? { filesRead: refs.filesRead } : {}),
          ...(refs.filesWritten.length > 0 ? { filesWritten: refs.filesWritten } : {}),
        });
      }
      continue;
    }
  }

  const observations = extractTurnObservations({ messages: scopedMessages }, helpers);
  for (const observation of observations) {
    const filePath =
      typeof observation.metadata?.path === "string" && observation.metadata.path.trim().length > 0
        ? observation.metadata.path.trim()
        : undefined;
    rawRecord.toolResults.push({
      anchor: toolAnchor,
      toolCallId: observation.id,
      toolName: observation.toolName ?? "unknown",
      status: observation.payloadKind === "stderr" ? "error" : "success",
      fullText: observation.text,
      summary: summarizeText(observation.text, 800),
      rawContentRef: filePath,
      ...(observation.recovery ? { recovery: observation.recovery } : {}),
      ...(filePath
        ? isWriteLikeToolName(observation.toolName)
          ? { filesWritten: [filePath] }
          : { filesRead: [filePath] }
        : {}),
    });
  }

  if (
    rawRecord.messages.length === 0 &&
    rawRecord.toolCalls.length === 0 &&
    rawRecord.toolResults.length === 0
  ) {
    return null;
  }

  return rawRecord;
}

export function buildRawSemanticTurnRecordFromTranscript(
  sessionId: string,
  messages: any[],
  turnSeq: number,
  helpers: TranscriptHelpers,
): RawSemanticTurnRecord | null {
  if (!messages || messages.length === 0) return null;
  const scopedMessages = sliceMessagesForTurnSeq(messages, turnSeq);
  if (scopedMessages.length === 0) return null;
  return buildRawSemanticTurnRecordFromMessages(sessionId, turnSeq, scopedMessages, helpers);
}
