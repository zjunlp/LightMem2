/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  loadRawSemanticTurnRecord,
  persistRawSemanticTurnRecord,
} from "@tokenpilot/history";
import { readTranscriptMessagesForSession, transcriptMessageStableId } from "./transcript-io.js";
import {
  dedupeRawSemanticMessages,
  dedupeRawSemanticToolCalls,
  dedupeRawSemanticToolResults,
} from "./transcript-sync-dedupe.js";
import { buildRawSemanticTurnRecordFromTranscript } from "./transcript-sync-record.js";
import type { TranscriptHelpers } from "./transcript-types.js";
export type { StructuredTurnObservation, TranscriptHelpers, TranscriptSessionRow } from "./transcript-types.js";
export { extractTurnObservations, inferObservationPayloadKind } from "./transcript-observations.js";
export { readTranscriptEntriesForSession, readTranscriptMessagesForSession, transcriptMessageStableId } from "./transcript-io.js";

export async function syncRawSemanticTurnsFromTranscript(
  stateDir: string,
  sessionId: string,
  helpers: TranscriptHelpers,
): Promise<{ changed: boolean; turnCount: number; updatedTurnSeqs: number[] }> {
  const messages = await readTranscriptMessagesForSession(sessionId);
  if (!messages || messages.length === 0) {
    return { changed: false, turnCount: 0, updatedTurnSeqs: [] };
  }
  let turnCount = 0;
  for (const message of messages) {
    if (String(message?.role ?? "").toLowerCase() === "user") {
      turnCount += 1;
    }
  }
  if (turnCount === 0) {
    return { changed: false, turnCount: 0, updatedTurnSeqs: [] };
  }
  const updatedTurnSeqs: number[] = [];
  for (let turnSeq = 1; turnSeq <= turnCount; turnSeq += 1) {
    const record = buildRawSemanticTurnRecordFromTranscript(sessionId, messages, turnSeq, helpers);
    if (!record) continue;
    const existing = await loadRawSemanticTurnRecord(stateDir, sessionId, turnSeq);
    const nextMessages = dedupeRawSemanticMessages(record.messages);
    const nextToolCalls = dedupeRawSemanticToolCalls(record.toolCalls);
    const nextToolResults = dedupeRawSemanticToolResults(record.toolResults);
    const same =
      existing
      && JSON.stringify(existing.messages) === JSON.stringify(nextMessages)
      && JSON.stringify(existing.toolCalls) === JSON.stringify(nextToolCalls)
      && JSON.stringify(existing.toolResults) === JSON.stringify(nextToolResults);
    if (same) continue;
    await persistRawSemanticTurnRecord(stateDir, {
      ...record,
      messages: nextMessages,
      toolCalls: nextToolCalls,
      toolResults: nextToolResults,
    });
    updatedTurnSeqs.push(turnSeq);
  }
  return {
    changed: updatedTurnSeqs.length > 0,
    turnCount,
    updatedTurnSeqs,
  };
}
