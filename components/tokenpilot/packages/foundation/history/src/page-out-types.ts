import type { TranscriptTurn } from "@tokenpilot/kernel";

export type CanonicalMessageRole = "system" | "user" | "assistant" | "tool";

export type CanonicalTaskLifecycle = "active" | "blocked" | "completed" | "evictable";

export type CanonicalTaskAnchor = {
  taskId: string;
  turnId: string;
  turnSeq: number;
  role: CanonicalMessageRole;
};

export type CanonicalMessage = {
  messageId: string;
  role: CanonicalMessageRole;
  content: string;
  turnId?: string;
  taskIds?: string[];
  metadata?: Record<string, unknown>;
};

export type CanonicalTaskBlock = {
  blockId: string;
  taskId: string;
  title?: string;
  lifecycle: CanonicalTaskLifecycle;
  messageIds: string[];
  turnIds: string[];
  charCount: number;
  metadata?: Record<string, unknown>;
};

export type CanonicalState = {
  version: number;
  sessionId: string;
  messages: CanonicalMessage[];
  taskBlocks: CanonicalTaskBlock[];
  seenTurnIds: string[];
  updatedAt: string;
};

export type PageOutCandidate = {
  taskId: string;
  lifecycle: CanonicalTaskLifecycle;
  messageIds: string[];
  turnIds: string[];
  charCount: number;
  reason?: string;
};

export type EvictionReplacement =
  | {
      kind: "pointer_stub";
      taskId: string;
      summary: string;
      pointerId?: string;
    }
  | {
      kind: "drop";
      taskId: string;
      summary?: string;
    };

export type PageOutDecision = {
  evictableTaskIds: string[];
  candidates: PageOutCandidate[];
  replacements: EvictionReplacement[];
  metadata?: Record<string, unknown>;
};

export type ContextRewritePlan = {
  sessionId: string;
  inputTurns: TranscriptTurn[];
  nextCanonicalState: CanonicalState;
  pageOutDecision?: PageOutDecision;
  changed: boolean;
  metadata?: Record<string, unknown>;
};
