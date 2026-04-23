import type {
  DeltaInputMode,
  DeltaTaskSummary,
  DeltaToolCall,
  DeltaToolResult,
  DeltaTurnMessage,
  DeltaView,
  RawSemanticSnapshot,
  SessionTaskRegistry,
  TaskLifecycle,
  TurnAnchor,
} from "./types.js";

export type BuildDeltaViewOptions = {
  fromTurnSeqExclusive: number;
  toTurnSeqInclusive?: number;
  currentActiveTaskHint?: string;
  inputMode?: DeltaInputMode;
  completedTaskSummaries?: DeltaTaskSummary[];
};

function dedupeOrdered(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function isCovered(anchor: TurnAnchor, fromTurnSeqExclusive: number, toTurnSeqInclusive: number): boolean {
  return anchor.turnSeq > fromTurnSeqExclusive && anchor.turnSeq <= toTurnSeqInclusive;
}

export function buildDeltaViewFromRawSemanticSnapshot(
  snapshot: RawSemanticSnapshot,
  options: BuildDeltaViewOptions,
): DeltaView {
  const toTurnSeqInclusive = Math.max(
    options.fromTurnSeqExclusive,
    options.toTurnSeqInclusive ?? snapshot.lastTurnSeq,
  );

  const messages: DeltaTurnMessage[] = snapshot.messages
    .filter((record) => isCovered(record.anchor, options.fromTurnSeqExclusive, toTurnSeqInclusive))
    .map((record) => ({
      anchor: record.anchor,
      role: record.role,
      text: record.text,
      source: "raw",
    }));

  const toolCalls: DeltaToolCall[] = snapshot.toolCalls
    .filter((record) => isCovered(record.anchor, options.fromTurnSeqExclusive, toTurnSeqInclusive))
    .map((record) => ({
      anchor: record.anchor,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      argumentsSummary: record.argumentsSummary,
    }));

  const toolResults: DeltaToolResult[] = snapshot.toolResults
    .filter((record) => isCovered(record.anchor, options.fromTurnSeqExclusive, toTurnSeqInclusive))
    .map((record) => ({
      anchor: record.anchor,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      status: record.status,
      summary: record.summary,
      rawContentRef: record.rawContentRef,
      recovery: record.recovery,
    }));

  const coveredTurnAbsIds = dedupeOrdered([
    ...messages.map((record) => record.anchor.turnAbsId),
    ...toolCalls.map((record) => record.anchor.turnAbsId),
    ...toolResults.map((record) => record.anchor.turnAbsId),
  ]);

  const filesRead = dedupeOrdered([
    ...snapshot.toolCalls
      .filter((record) => isCovered(record.anchor, options.fromTurnSeqExclusive, toTurnSeqInclusive))
      .flatMap((record) => record.filesRead ?? []),
    ...snapshot.toolResults
      .filter((record) => isCovered(record.anchor, options.fromTurnSeqExclusive, toTurnSeqInclusive))
      .flatMap((record) => record.filesRead ?? []),
  ]);

  const filesWritten = dedupeOrdered([
    ...snapshot.toolCalls
      .filter((record) => isCovered(record.anchor, options.fromTurnSeqExclusive, toTurnSeqInclusive))
      .flatMap((record) => record.filesWritten ?? []),
    ...snapshot.toolResults
      .filter((record) => isCovered(record.anchor, options.fromTurnSeqExclusive, toTurnSeqInclusive))
      .flatMap((record) => record.filesWritten ?? []),
  ]);

  return {
    inputMode: options.inputMode ?? "sliding_window",
    fromTurnSeqExclusive: options.fromTurnSeqExclusive,
    toTurnSeqInclusive,
    coveredTurnAbsIds,
    messages,
    toolCalls,
    toolResults,
    filesRead,
    filesWritten,
    currentActiveTaskHint: options.currentActiveTaskHint,
    completedTaskSummaries: options.completedTaskSummaries ?? [],
  };
}

function summarizeTaskForEstimator(task: SessionTaskRegistry["tasks"][string]): DeltaTaskSummary {
  const completionEvidence = dedupeOrdered(task.completionEvidence) ?? [];
  const unresolvedQuestions = dedupeOrdered(task.unresolvedQuestions) ?? [];
  const supportingTurnAbsIds = dedupeOrdered(task.span?.supportingTurnAbsIds ?? []) ?? [];
  const evidenceSummary = completionEvidence.slice(0, 3).join("; ");
  const unresolvedSummary = unresolvedQuestions.slice(0, 2).join("; ");
  const summaryParts = [
    `Task \`${task.taskId}\` is ${task.lifecycle}.`,
    task.title ? `Title: ${task.title}.` : "",
    task.objective ? `Objective: ${task.objective}.` : "",
    evidenceSummary ? `Completion evidence: ${evidenceSummary}.` : "",
    unresolvedSummary ? `Open questions: ${unresolvedSummary}.` : "",
  ].filter((part) => part.trim().length > 0);
  return {
    taskId: task.taskId,
    title: task.title,
    objective: task.objective,
    lifecycle: task.lifecycle,
    completionEvidence,
    unresolvedQuestions,
    supportingTurnAbsIds,
    summary: summaryParts.join(" "),
  };
}

function turnSeqFromAbsId(turnAbsId: string): number | null {
  const raw = turnAbsId.split(":t").at(-1) ?? "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function registryTaskIdsByLifecycle(
  registry: SessionTaskRegistry,
  lifecycles: TaskLifecycle[],
): string[] {
  const allow = new Set(lifecycles);
  return Object.values(registry.tasks)
    .filter((task) => allow.has(task.lifecycle))
    .map((task) => task.taskId);
}

export function deriveCompletedSummaryPlusActiveTurnsWindow(
  registry: SessionTaskRegistry,
  pendingTurnSeqs: number[],
  batchTurns: number,
): {
  fromTurnSeqExclusive: number;
  toTurnSeqInclusive: number;
  completedTaskSummaries: DeltaTaskSummary[];
} {
  const toTurnSeqInclusive = pendingTurnSeqs[Math.max(0, batchTurns - 1)] ?? pendingTurnSeqs.at(-1) ?? registry.lastProcessedTurnSeq;
  const unresolvedTaskIds = new Set(registryTaskIdsByLifecycle(registry, ["active", "blocked"]));
  let earliestRelevantTurnSeq = Math.max(1, registry.lastProcessedTurnSeq + 1);
  for (const taskId of unresolvedTaskIds) {
    const task = registry.tasks[taskId];
    if (!task) continue;
    for (const turnAbsId of task.span.supportingTurnAbsIds) {
      const turnSeq = turnSeqFromAbsId(turnAbsId);
      if (turnSeq !== null) earliestRelevantTurnSeq = Math.min(earliestRelevantTurnSeq, turnSeq);
    }
  }
  const completedTaskSummaries = Object.values(registry.tasks)
    .filter((task) => task.lifecycle === "completed" || task.lifecycle === "evictable")
    .map((task) => summarizeTaskForEstimator(task));

  return {
    fromTurnSeqExclusive: Math.max(0, earliestRelevantTurnSeq - 1),
    toTurnSeqInclusive,
    completedTaskSummaries,
  };
}
