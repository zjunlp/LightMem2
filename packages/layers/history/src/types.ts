import type { ContextSegment } from "@ecoclaw/kernel";

export type HistoryBlockType =
  | "tool_result"
  | "write_result"
  | "assistant_reply"
  | "system_context"
  | "summary_seed"
  | "pointer_stub"
  | "other";

export type HistoryLifecycleState =
  | "ACTIVE"
  | "COMPACTABLE"
  | "COMPACTED"
  | "EVICTABLE"
  | "EVICTED_CACHED"
  | "EVICTED_DROPPED";

export type HistorySignalType =
  | "READ_CONSUMED_BY_WRITE"
  | "REPEATED_READ"
  | "FAILED_TOOL_PATH"
  | "LARGE_BLOCK"
  | "RECENT_BLOCK";

export type TurnAnchorRole = "user" | "assistant" | "tool";

export type TurnAnchor = {
  sessionId: string;
  turnAbsId: string;
  turnSeq: number;
  role: TurnAnchorRole;
};

export type DeltaTurnMessage = {
  anchor: TurnAnchor;
  role: "user" | "assistant";
  text: string;
  source: "raw";
};

export type DeltaToolCall = {
  anchor: TurnAnchor;
  toolCallId: string;
  toolName: string;
  argumentsSummary: string;
};

export type DeltaToolResult = {
  anchor: TurnAnchor;
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  summary: string;
  rawContentRef?: string;
  recovery?: RecoveryMetadata;
};

export type DeltaTaskSummary = {
  taskId: string;
  title: string;
  objective: string;
  lifecycle: TaskLifecycle;
  completionEvidence: string[];
  unresolvedQuestions: string[];
  supportingTurnAbsIds: string[];
  summary: string;
};

export type DeltaInputMode = "sliding_window" | "completed_summary_plus_active_turns";

export type DeltaView = {
  inputMode?: DeltaInputMode;
  fromTurnSeqExclusive: number;
  toTurnSeqInclusive: number;
  coveredTurnAbsIds: string[];
  messages: DeltaTurnMessage[];
  toolCalls: DeltaToolCall[];
  toolResults: DeltaToolResult[];
  filesRead: string[];
  filesWritten: string[];
  currentActiveTaskHint?: string;
  completedTaskSummaries?: DeltaTaskSummary[];
};

export type RawSemanticMessageRecord = {
  anchor: TurnAnchor;
  role: "user" | "assistant";
  text: string;
};

export type RawSemanticToolCallRecord = {
  anchor: TurnAnchor;
  toolCallId: string;
  toolName: string;
  argumentsText?: string;
  argumentsSummary: string;
  filesRead?: string[];
  filesWritten?: string[];
};

export type RawSemanticToolResultRecord = {
  anchor: TurnAnchor;
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  fullText: string;
  summary: string;
  rawContentRef?: string;
  filesRead?: string[];
  filesWritten?: string[];
  recovery?: RecoveryMetadata;
};

export type RecoveryMetadata = {
  source: string;
  skipReduction?: boolean;
  skipCompaction?: boolean;
};

export type RawSemanticSnapshot = {
  sessionId: string;
  lastTurnSeq: number;
  messages: RawSemanticMessageRecord[];
  toolCalls: RawSemanticToolCallRecord[];
  toolResults: RawSemanticToolResultRecord[];
};

export type RawSemanticTurnRecord = {
  sessionId: string;
  turnSeq: number;
  turnAbsId: string;
  messages: RawSemanticMessageRecord[];
  toolCalls: RawSemanticToolCallRecord[];
  toolResults: RawSemanticToolResultRecord[];
};

export type TaskLifecycle = "active" | "blocked" | "completed" | "evictable";

export type TaskStateSpan = {
  firstTurnAbsId: string;
  lastTurnAbsId: string;
  supportingTurnAbsIds: string[];
  lastEstimatorTurnAbsId: string;
};

export type TaskState = {
  taskId: string;
  title: string;
  objective: string;
  lifecycle: TaskLifecycle;
  currentSubgoal?: string;
  evictableReason?: string;
  completionEvidence: string[];
  unresolvedQuestions: string[];
  span: TaskStateSpan;
};

export type SessionTaskRegistryPatch = {
  upsertTasks?: Record<string, TaskState>;
  removeTaskIds?: string[];
  activeTaskIds?: string[];
  completedTaskIds?: string[];
  evictableTaskIds?: string[];
  upsertTaskToBlockIds?: Record<string, string[]>;
  upsertBlockToTaskIds?: Record<string, string[]>;
  upsertTurnToTaskIds?: Record<string, string[]>;
  lastProcessedTurnSeq?: number;
};

export type SessionTaskRegistry = {
  sessionId: string;
  version: number;
  tasks: Record<string, TaskState>;
  activeTaskIds: string[];
  completedTaskIds: string[];
  evictableTaskIds: string[];
  taskToBlockIds: Record<string, string[]>;
  blockToTaskIds: Record<string, string[]>;
  turnToTaskIds: Record<string, string[]>;
  lastProcessedTurnSeq: number;
};

export type HistoryBlock = {
  blockId: string;
  blockType: HistoryBlockType;
  lifecycleState: HistoryLifecycleState;
  segmentIds: string[];
  text: string;
  charCount: number;
  approxTokens: number;
  createdAt?: string;
  source?: string;
  toolName?: string;
  dataKey?: string;
  priority?: number;
  localityScore?: number;
  importanceScore?: number;
  signals?: HistorySignal[];
  signalTypes?: HistorySignalType[];
  consumedByBlockIds?: string[];
  turnAnchors?: TurnAnchor[];
  turnAbsIds?: string[];
  taskIds?: string[];
  transitionEvidence?: HistoryTransitionEvidence[];
  metadata?: Record<string, unknown>;
};

export type HistorySignal = {
  type: HistorySignalType;
  blockId: string;
  confidence: number;
  rationale: string;
  metadata?: Record<string, unknown>;
};

export type HistoryTransitionEvidence = {
  fromState: HistoryLifecycleState;
  toState: HistoryLifecycleState;
  reason: string;
  signalTypes: HistorySignalType[];
};

export type HistoryChunkingResult = {
  blocks: HistoryBlock[];
  segmentToBlockId: Map<string, string>;
};

export type HistoryChunkingConfig = {
  largeBlockChars?: number;
};

export type HistoryScoringConfig = {
  recentWindowSize?: number;
  largeBlockChars?: number;
};

export type HistorySegmentLike = ContextSegment;

export type HistoryLifecycleConfig = {
  compactableSignalConfidenceMin?: number;
};

export type HistoryLifecycleDerivationResult = {
  blocks: HistoryBlock[];
  blockSignals: Map<string, HistorySignal[]>;
};

export type HistoryTaskRegistryConfig = {
  enabled?: boolean;
};
