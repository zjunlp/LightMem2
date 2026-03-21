export type CacheNodeId = string;

export type CacheTreeSnapshot = {
  sessionId: string;
  provider: string;
  model: string;
  createdAt: string;
  prefixSignature: string;
  prefixSignatureNormalized: string;
  contextSignature?: string;
  contextChars?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  metadata?: Record<string, unknown>;
};

export type CacheNode = CacheTreeSnapshot & {
  id: CacheNodeId;
  parentId?: CacheNodeId;
  branch: string;
  children: CacheNodeId[];
  lastHitAt: string;
  ttlSeconds: number;
  expiresAt: string;
  hitCount: number;
};

export type CacheBranchCandidate = {
  nodeId: CacheNodeId;
  branch: string;
  provider: string;
  model: string;
  expiresAt: string;
  score: number;
  reason: string;
};

export type CacheTreeState = {
  sessionId: string;
  nodes: Record<CacheNodeId, CacheNode>;
  headByBranch: Record<string, CacheNodeId>;
  latestNodeId?: CacheNodeId;
};

export type CacheTreeRegisterInput = {
  snapshot: CacheTreeSnapshot;
  preferredParentId?: CacheNodeId;
  branch?: string;
};

export type CacheTreeOptions = {
  defaultBranch?: string;
  ttlSeconds?: number;
};

export type CacheCandidateFilter = {
  includeExpired?: boolean;
  prefixSignature?: string;
  prefixSignatureNormalized?: string;
};
