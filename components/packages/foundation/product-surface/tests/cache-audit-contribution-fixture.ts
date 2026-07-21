import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  registerProductSurfaceCacheAuditContribution,
  type ProductSurfaceCacheAuditRecord,
} from "../src/feature-contributions.js";

export function registerTestCacheAuditContribution(): void {
  registerProductSurfaceCacheAuditContribution({
    async readRecentRecordsForSession(stateDir, sessionId, limit) {
      try {
        const raw = await readFile(join(stateDir, "cache-audit.jsonl"), "utf8");
        return raw
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ProductSurfaceCacheAuditRecord)
          .filter((record) => record.sessionId === sessionId)
          .reverse()
          .slice(0, limit);
      } catch {
        return [];
      }
    },
    summarize(records) {
      const ordered = records.slice().reverse();
      const seen = new Set<string>();
      let warmCandidates = 0;
      let warmHits = 0;
      let warmMisses = 0;
      let rewrites = 0;
      for (const record of ordered) {
        const identity = `${record.requestPromptCacheKey ?? record.sessionId}:${record.stablePrefixFingerprint}`;
        if (seen.has(identity)) {
          warmCandidates += 1;
          if (record.cachedInputTokens > 0) warmHits += 1;
          else warmMisses += 1;
        }
        seen.add(identity);
        if (record.responsePromptCacheKey && record.responsePromptCacheKey !== record.requestPromptCacheKey) rewrites += 1;
      }
      return {
        totalRecords: records.length,
        warmCandidates,
        warmHits,
        warmMisses,
        hitRatePercent: warmCandidates > 0 ? (warmHits / warmCandidates) * 100 : 0,
        latestSessionId: records[0]?.sessionId,
        latestFingerprint: records[0]?.stablePrefixFingerprint,
        topEntropyKinds: [],
        topDriftKeys: [],
        responsePromptCacheKeyRewriteCount: rewrites,
        promptCacheKeyMismatchCount: rewrites,
      };
    },
    diagnose(record) {
      const rewriteDetected = Boolean(
        record.responsePromptCacheKey
        && record.responsePromptCacheKey !== record.requestPromptCacheKey,
      );
      return {
        matchedResult: record.cachedInputTokens > 0 ? "warm hit" : "cold miss",
        rewriteDetected,
        currentState: record.cachedInputTokens > 0 ? "Warm hit." : "Cold miss.",
        targetState: "Stable warm cache.",
        optimizationHint: "Keep the prefix stable.",
        killers: [{ title: "Drift", fix: "Keep stable fields fixed.", detail: "Test diagnosis." }],
        harnessRules: ["Keep adjacent request prefixes stable."],
      };
    },
  });
}
