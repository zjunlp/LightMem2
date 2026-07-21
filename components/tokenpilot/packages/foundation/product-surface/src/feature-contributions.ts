export type ProductSurfaceCacheAuditFinding = {
  kind: string;
  segmentKey: string;
  layer: string;
  detail: string;
};

export type ProductSurfaceCacheAuditDriftReason = {
  kind: string;
  key: string;
  detail: string;
};

export type ProductSurfaceCacheAuditRecord = {
  at: string;
  sessionId: string;
  model: string;
  stream: boolean;
  stablePrefixFingerprint: string;
  entropyFindings: ProductSurfaceCacheAuditFinding[];
  driftReasons: ProductSurfaceCacheAuditDriftReason[];
  originalRequestPromptCacheKey: string | null;
  requestPromptCacheKey: string | null;
  responsePromptCacheKey: string | null;
  cachedInputTokens: number;
  status: number;
  baselineKind?: "identity" | "request_key" | "session" | "none";
};

export type ProductSurfaceCacheAuditContributionSummary = {
  totalRecords: number;
  warmCandidates: number;
  warmHits: number;
  warmMisses: number;
  hitRatePercent: number;
  latestSessionId?: string;
  latestFingerprint?: string;
  topEntropyKinds: Array<{ key: string; count: number }>;
  topDriftKeys: Array<{ key: string; count: number }>;
  responsePromptCacheKeyRewriteCount: number;
  promptCacheKeyMismatchCount: number;
};

export type ProductSurfaceCacheAuditDiagnosis = {
  matchedResult: "warm hit" | "cold miss" | "cold start" | "unmatched";
  rewriteDetected: boolean;
  currentState: string;
  targetState: string;
  optimizationHint: string;
  killers: Array<{ title: string; fix: string; detail: string }>;
  harnessRules: string[];
};

export type ProductSurfaceCacheAuditContribution = {
  readRecentRecordsForSession(
    stateDir: string,
    sessionId: string,
    limit: number,
  ): Promise<ProductSurfaceCacheAuditRecord[]>;
  summarize(records: ProductSurfaceCacheAuditRecord[]): ProductSurfaceCacheAuditContributionSummary;
  diagnose(record: ProductSurfaceCacheAuditRecord): ProductSurfaceCacheAuditDiagnosis;
};

let cacheAuditContribution: ProductSurfaceCacheAuditContribution | undefined;

export function registerProductSurfaceCacheAuditContribution(
  contribution: ProductSurfaceCacheAuditContribution,
): void {
  cacheAuditContribution = contribution;
}

export function getProductSurfaceCacheAuditContribution(): ProductSurfaceCacheAuditContribution | undefined {
  return cacheAuditContribution;
}
