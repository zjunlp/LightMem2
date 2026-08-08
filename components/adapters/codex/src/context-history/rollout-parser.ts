import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import {
  asJsonObject,
  hashJson,
  sanitizeValue,
} from "./shared.js";
import { codexReplayabilityForItem, codexReplayPairRef } from "./replayability.js";
import type {
  CodexEffectiveHistory,
  CodexEffectiveHistoryItem,
  CodexRolloutSessionMeta,
  CodexRolloutSnapshot,
  CodexRolloutTaskEvidence,
  JsonObject,
} from "./types.js";

type RolloutRecord = {
  type?: unknown;
  payload?: unknown;
};

function itemType(item: JsonObject): string {
  if (typeof item.type === "string") return item.type;
  if (typeof item.role === "string") return `message:${item.role}`;
  return "item";
}

function itemCallId(item: JsonObject): string | undefined {
  return typeof item.call_id === "string" ? item.call_id : undefined;
}

function isToolOutput(item: JsonObject): boolean {
  return codexReplayPairRef(item).side === "output";
}

type RolloutAccumulator = {
  replayCandidates: JsonObject[];
  observationCandidates: JsonObject[];
  malformedLineCount: number;
  malformedSinceBaseline: number;
  sessionMeta?: CodexRolloutSessionMeta;
  compactionBaselineApplied: boolean;
  unknownRecordTypeCounts: Record<string, number>;
  taskEvidence: CodexRolloutTaskEvidence;
};

function createAccumulator(): RolloutAccumulator {
  return {
    replayCandidates: [],
    observationCandidates: [],
    malformedLineCount: 0,
    malformedSinceBaseline: 0,
    compactionBaselineApplied: false,
    unknownRecordTypeCounts: {},
    taskEvidence: { completedTurnIds: [], abortedTurnIds: [] },
  };
}

function expectedOutputType(item: JsonObject): string | undefined {
  const ref = codexReplayPairRef(item);
  return ref.side === "call" ? `${ref.type}_output` : undefined;
}

function createEffectiveItem(
  item: JsonObject,
  occurrences: Map<string, number>,
): CodexEffectiveHistoryItem {
  const type = itemType(item);
  const callId = itemCallId(item);
  const baseNativeId = typeof item.id === "string"
    ? `${type}:id:${item.id}`
    : callId
      ? `${type}:call:${callId}`
      : `${type}:synthetic:${hashJson(item)}`;
  const occurrence = occurrences.get(baseNativeId) ?? 0;
  occurrences.set(baseNativeId, occurrence + 1);
  const nativeId = occurrence === 0
    ? baseNativeId
    : `${baseNativeId}:occurrence:${occurrence}`;

  return {
    stableItemId: `codex-${hashJson(nativeId)}`,
    nativeId,
    callId,
    item,
  };
}

function parseRecord(line: string): RolloutRecord | undefined {
  try {
    return asJsonObject(JSON.parse(line)) as RolloutRecord | undefined;
  } catch {
    return undefined;
  }
}

function parseSessionMeta(payload: JsonObject): CodexRolloutSessionMeta {
  return {
    sessionId: typeof payload.id === "string" ? payload.id : undefined,
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    originator: typeof payload.originator === "string" ? payload.originator : undefined,
    cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : undefined,
    source: typeof payload.source === "string" ? payload.source : undefined,
    modelProvider: typeof payload.model_provider === "string" ? payload.model_provider : undefined,
  };
}

function compactionReplacementItems(payload: JsonObject): JsonObject[] | undefined {
  if (Array.isArray(payload.replacement_history)) {
    return payload.replacement_history
      .map((item) => asJsonObject(sanitizeValue(item)))
      .filter((item): item is JsonObject => Boolean(item));
  }
  if (typeof payload.message === "string" && payload.message) {
    return [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: payload.message }],
    }];
  }
  return undefined;
}

function addTaskEvidence(payload: JsonObject, evidence: CodexRolloutTaskEvidence): void {
  const eventType = typeof payload.type === "string" ? payload.type : undefined;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
  if (!eventType || !turnId) return;
  if (eventType === "task_complete") evidence.completedTurnIds.push(turnId);
  if (eventType === "task_aborted" || eventType === "turn_aborted") {
    evidence.abortedTurnIds.push(turnId);
  }
}

function buildHistory(params: {
  replayCandidates: JsonObject[];
  observationCandidates: JsonObject[];
  malformedSinceBaseline: number;
}): CodexEffectiveHistory {
  const replayCandidates: JsonObject[] = [];
  const observationCandidates = [...params.observationCandidates];
  const deferredCandidates: JsonObject[] = [];
  for (const item of params.replayCandidates) {
    const replayability = codexReplayabilityForItem(item);
    if (replayability.mode === "replayable") replayCandidates.push(item);
    else if (replayability.mode === "observation_only") observationCandidates.push(item);
    else deferredCandidates.push(item);
  }

  const expectedOutputs = new Map<string, string>();
  const outputTypes = new Map<string, string>();
  for (const item of replayCandidates) {
    const callId = itemCallId(item);
    if (!callId) continue;
    const expectedType = expectedOutputType(item);
    if (expectedType) expectedOutputs.set(callId, expectedType);
    if (isToolOutput(item)) outputTypes.set(callId, itemType(item));
  }

  let incomplete = params.malformedSinceBaseline > 0 || deferredCandidates.length > 0;
  const occurrences = new Map<string, number>();
  const replayableItems: CodexEffectiveHistoryItem[] = [];
  for (const item of replayCandidates) {
    const callId = itemCallId(item);
    if (isToolOutput(item) && (
      !callId
      || expectedOutputs.get(callId) !== itemType(item)
    )) {
      incomplete = true;
      continue;
    }
    replayableItems.push(createEffectiveItem(item, occurrences));
  }

  const observationOnlyItems = observationCandidates.map((item) =>
    createEffectiveItem(item, occurrences)
  );
  const deferredItems = deferredCandidates.map((item) => createEffectiveItem(item, occurrences));
  const unresolvedCallIds = Array.from(expectedOutputs)
    .filter(([callId, expectedType]) => outputTypes.get(callId) !== expectedType)
    .map(([callId]) => callId)
    .sort();
  if (unresolvedCallIds.length > 0) incomplete = true;

  const revision = `rev-${hashJson({
    replayableItems: replayableItems.map((entry) => ({
      stableItemId: entry.stableItemId,
      fingerprint: hashJson(entry.item),
    })),
    observationOnlyItems: observationOnlyItems.map((entry) => ({
      stableItemId: entry.stableItemId,
      fingerprint: hashJson(entry.item),
    })),
    deferredItems: deferredItems.map((entry) => ({
      stableItemId: entry.stableItemId,
      fingerprint: hashJson(entry.item),
    })),
    unresolvedCallIds,
    incomplete,
  })}`;

  return {
    revision,
    replayableItems,
    observationOnlyItems,
    deferredItems,
    unresolvedCallIds,
    source: "rollout_bootstrap",
    incomplete,
  };
}

function consumeRolloutLine(accumulator: RolloutAccumulator, rawLine: string): void {
  const line = rawLine.trim();
  if (!line) return;
  const record = parseRecord(line);
  if (!record) {
    accumulator.malformedLineCount += 1;
    accumulator.malformedSinceBaseline += 1;
    return;
  }

  const recordType = typeof record.type === "string" ? record.type : undefined;
  const payload = asJsonObject(sanitizeValue(record.payload));
  if (!recordType || !payload) {
    accumulator.malformedLineCount += 1;
    accumulator.malformedSinceBaseline += 1;
    return;
  }

  if (recordType === "session_meta") {
    accumulator.sessionMeta = parseSessionMeta(payload);
    return;
  }
  if (recordType === "response_item") {
    accumulator.replayCandidates.push(payload);
    return;
  }
  if (recordType === "compacted") {
    const replacementItems = compactionReplacementItems(payload);
    if (!replacementItems) {
      accumulator.malformedLineCount += 1;
      accumulator.malformedSinceBaseline += 1;
      return;
    }
    accumulator.replayCandidates = replacementItems;
    accumulator.observationCandidates = [];
    accumulator.malformedSinceBaseline = 0;
    accumulator.taskEvidence = { completedTurnIds: [], abortedTurnIds: [] };
    accumulator.compactionBaselineApplied = true;
    return;
  }
  if (recordType === "turn_context" || recordType === "event_msg") {
    if (recordType === "event_msg") addTaskEvidence(payload, accumulator.taskEvidence);
    accumulator.observationCandidates.push({ type: recordType, payload });
    return;
  }
  accumulator.unknownRecordTypeCounts[recordType] = (
    accumulator.unknownRecordTypeCounts[recordType] ?? 0
  ) + 1;
}

function finishRolloutSnapshot(accumulator: RolloutAccumulator): CodexRolloutSnapshot | null {
  if (
    accumulator.replayCandidates.length === 0
    && accumulator.observationCandidates.length === 0
    && !accumulator.sessionMeta
  ) {
    return null;
  }
  return {
    history: buildHistory({
      replayCandidates: accumulator.replayCandidates,
      observationCandidates: accumulator.observationCandidates,
      malformedSinceBaseline: accumulator.malformedSinceBaseline,
    }),
    sessionMeta: accumulator.sessionMeta,
    malformedLineCount: accumulator.malformedLineCount,
    unknownRecordTypeCounts: accumulator.unknownRecordTypeCounts,
    taskEvidence: {
      completedTurnIds: Array.from(new Set(accumulator.taskEvidence.completedTurnIds)),
      abortedTurnIds: Array.from(new Set(accumulator.taskEvidence.abortedTurnIds)),
    },
    compactionBaselineApplied: accumulator.compactionBaselineApplied,
  };
}

export function parseCodexRolloutText(params: {
  text: string;
}): CodexRolloutSnapshot | null {
  const accumulator = createAccumulator();
  for (const rawLine of params.text.split(/\r?\n/u)) consumeRolloutLine(accumulator, rawLine);
  return finishRolloutSnapshot(accumulator);
}

export async function parseCodexRollout(
  rolloutPath: string,
): Promise<CodexRolloutSnapshot | null> {
  const accumulator = createAccumulator();
  try {
    const lines = createInterface({
      input: createReadStream(rolloutPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) consumeRolloutLine(accumulator, line);
    return finishRolloutSnapshot(accumulator);
  } catch {
    return null;
  }
}

export async function parseCodexRolloutFile(params: {
  rolloutPath: string;
}): Promise<CodexRolloutSnapshot | null> {
  return parseCodexRollout(params.rolloutPath);
}
