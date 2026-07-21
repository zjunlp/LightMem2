export type DistillStatus = "queued" | "inflight" | "distilled" | "failed";

export type ProceduralMemoryQueueEntry = {
  queueId: string;
  sessionId: string;
  taskId: string;
  archivePath: string;
  archiveSourceLabel: string;
  archiveDigest?: string;
  objective: string;
  completionEvidence: string[];
  unresolvedQuestions: string[];
  turnAbsIds: string[];
  createdAt: string;
  updatedAt: string;
  status: DistillStatus;
  attemptCount: number;
  lastError?: string;
};

export type ProceduralSkill = {
  skillId: string;
  sourceTaskId: string;
  sessionId: string;
  title: string;
  objective: string;
  guidance: string;
  whenToUse: string[];
  steps: string[];
  facts: string[];
  pitfalls: string[];
  constraints: string[];
  evidence: string[];
  embeddingText: string;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
};

export type DistillBatchResult = {
  produced: ProceduralSkill[];
  failed: Array<{ queueId: string; error: string }>;
};

export type SkillDistiller = {
  distill(params: {
    entries: ProceduralMemoryQueueEntry[];
  }): Promise<ProceduralSkill[]>;
};

export type RetrieveSkillsParams = {
  sessionId: string;
  objective: string;
  topK: number;
};

export type SkillRetrieveHit = {
  skill: ProceduralSkill;
  score: number;
};

export type ProceduralMemoryBackend = {
  enqueue(entries: Omit<ProceduralMemoryQueueEntry, "queueId" | "createdAt" | "updatedAt" | "status" | "attemptCount">[]): Promise<number>;
  drainBatch(limit: number): Promise<ProceduralMemoryQueueEntry[]>;
  completeBatch(entries: ProceduralMemoryQueueEntry[], produced: ProceduralSkill[]): Promise<void>;
  failBatch(entries: ProceduralMemoryQueueEntry[], reason: string): Promise<void>;
  retrieve(params: RetrieveSkillsParams): Promise<SkillRetrieveHit[]>;
};

export type EmbeddingProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  queryInstruction?: string;
};

export type DistillProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  requestTimeoutMs?: number;
};
