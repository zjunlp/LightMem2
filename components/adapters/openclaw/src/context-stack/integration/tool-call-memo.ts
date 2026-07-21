/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  archiveContent,
  pluginStateSubdir,
} from "@lightmem2/artifact-store";
import { buildMemoKey, extractTextFromToolResult, extractTranscriptFullText } from "./tool-call-memo-keys.js";
import {
  buildDataKey,
  getTranscriptMemoMinCallsBeforeBlock,
  hashText,
  insertMemoRecord,
  TOOL_ACCESS_COUNT,
  TOOL_RESULT_MEMO,
  trimText,
  type MemoHelpers,
} from "./tool-call-memo-shared.js";

export async function recordToolCallMemo(
  event: any,
  cfg: { stateDir: string },
  helpers: MemoHelpers,
): Promise<void> {
  const toolName = trimText(event?.toolName).toLowerCase();
  const memoKey = await buildMemoKey(event);
  if (helpers.appendTaskStateTrace) {
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "tool_call_memo_after_inspect",
      toolName,
      toolCallId: trimText(event?.toolCallId) || null,
      hasMemoKey: Boolean(memoKey),
    });
  }
  if (!memoKey) return;
  const transcriptFullText = await extractTranscriptFullText(event);
  const text = transcriptFullText ?? extractTextFromToolResult(event?.result);
  if (helpers.appendTaskStateTrace) {
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "tool_call_memo_after_text",
      toolName,
      toolCallId: trimText(event?.toolCallId) || null,
      textChars: text.length,
    });
  }
  if (!text || text.length < 2048) return;
  const sessionId = trimText(event?.sessionId) || "proxy-session";
  const toolCallId = trimText(event?.toolCallId);
  const dataKey = buildDataKey(toolName || "tool", helpers.safeId(toolCallId), text);
  let outputFile: string | undefined;
  try {
    const archived = await archiveContent({
      sessionId,
      segmentId: toolCallId || hashText(text),
      sourcePass: "memo_tool_result",
      toolName: toolName || "tool",
      dataKey,
      originalText: text,
      archiveDir: pluginStateSubdir(cfg.stateDir, "tool-result-archives", sessionId),
      metadata: {
        toolCallId: toolCallId || undefined,
        persistedBy: "plugin.tool_call_memo",
        memoToolName: toolName || "tool",
      },
    });
    outputFile = archived.archivePath;
  } catch {
    outputFile = undefined;
  }
  if (!outputFile) {
    if (helpers.appendTaskStateTrace) {
      await helpers.appendTaskStateTrace(cfg.stateDir, {
        stage: "tool_call_memo_after_no_datakey",
        toolName,
        toolCallId: toolCallId || null,
      });
    }
    return;
  }
  insertMemoRecord({
    toolName,
    memoKey,
    dataKey,
    outputFile,
    resultHash: hashText(text),
    createdAt: new Date().toISOString(),
  });
  if (helpers.appendTaskStateTrace) {
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "tool_call_memo_after_stored",
      toolName,
      toolCallId: toolCallId || null,
      memoKey,
      dataKey,
      outputFile: outputFile ?? null,
      textChars: text.length,
    });
  }
}

export async function maybeBlockRepeatedToolCall(
  event: any,
  cfg?: { stateDir: string },
  helpers?: Pick<MemoHelpers, "appendTaskStateTrace">,
): Promise<string | undefined> {
  const memoKey = await buildMemoKey(event);
  const toolName = trimText(event?.toolName).toLowerCase();
  const toolCallId = trimText(event?.toolCallId) || null;
  const accessCount = memoKey ? (TOOL_ACCESS_COUNT.get(memoKey) ?? 0) + 1 : 0;
  if (memoKey) TOOL_ACCESS_COUNT.set(memoKey, accessCount);
  const minCallsBeforeBlock = getTranscriptMemoMinCallsBeforeBlock();
  if (helpers?.appendTaskStateTrace && cfg?.stateDir) {
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "tool_call_memo_before_lookup",
      toolName,
      toolCallId,
      hasMemoKey: Boolean(memoKey),
      memoKey: memoKey ?? null,
      accessCount: memoKey ? accessCount : null,
      minCallsBeforeBlock,
    });
  }
  if (!memoKey) return undefined;
  const record = TOOL_RESULT_MEMO.get(memoKey);
  const gateOpen = accessCount > minCallsBeforeBlock;
  if (helpers?.appendTaskStateTrace && cfg?.stateDir) {
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "tool_call_memo_before_result",
      toolName,
      toolCallId,
      memoKey,
      hit: Boolean(record),
      dataKey: record?.dataKey ?? null,
      accessCount,
      minCallsBeforeBlock,
      gateOpen,
    });
  }
  if (!record || !gateOpen) return undefined;
  const outputRef = record.outputFile ? ` Archived result: ${record.outputFile}.` : "";
  return [
    `This ${record.toolName} call targets transcript content that has already been retrieved multiple times with the same content hash (${record.resultHash}).`,
    `You have already accessed this transcript ${accessCount} times in the current session.`,
    `Prefer reusing previously gathered context instead of calling the original tool again.${outputRef}`,
    `Only if you still need the archived full content should you call ${MEMORY_FAULT_RECOVER_TOOL_NAME} with {"dataKey":"${record.dataKey}"}.`,
  ].join(" ");
}
