import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  findRuntimeEventsByType,
  type RuntimeModule,
} from "@ecoclaw/kernel";
import { createHash } from "node:crypto";
import { CacheTreeManager } from "./manager.js";
import type { CacheTreeOptions } from "./types.js";

export type CacheModuleConfig = {
  minPrefixChars?: number;
  profileVersionTag?: string;
  tree?: CacheTreeOptions;
};

export function createCacheModule(cfg: CacheModuleConfig = {}): RuntimeModule {
  const minPrefixChars = cfg.minPrefixChars ?? 500;
  const profileVersionTag = cfg.profileVersionTag ?? "v1";
  const tree = new CacheTreeManager(cfg.tree ?? {});

  function signature(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  function normalizeStableText(text: string): string {
    return text
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<UUID>")
      .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:\.\+\-Z]{6,}\b/g, "<TIMESTAMP>")
      .replace(/\b\d{10,}\b/g, "<LONGNUM>");
  }

  return {
    name: "module-cache",
    async beforeBuild(ctx) {
      const stable = ctx.segments.filter((s) => s.kind === "stable").map((s) => s.text).join("\n");
      const cacheEligible = stable.length >= minPrefixChars;
      const cachePrefixSignature = signature(stable);
      const cachePrefixNormalizedSignature = signature(normalizeStableText(stable));
      const strictFilter = {
        prefixSignature: cachePrefixSignature,
        prefixSignatureNormalized: cachePrefixNormalizedSignature,
      };
      const parentCandidates = cacheEligible
        ? tree.listCandidates(ctx.sessionId, ctx.provider, ctx.model, {
            ...strictFilter,
            includeExpired: true,
          })
        : [];
      const liveCandidates = cacheEligible
        ? tree.listCandidates(ctx.sessionId, ctx.provider, ctx.model, {
            ...strictFilter,
            includeExpired: false,
          })
        : [];
      const selectedParent = parentCandidates[0];
      const selectedLive = liveCandidates[0];
      const nextCtx = {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          cache: {
            eligible: cacheEligible,
            profileVersionTag,
            prefixChars: stable.length,
            prefixSignature: cachePrefixSignature,
            prefixSignatureNormalized: cachePrefixNormalizedSignature,
            tree: {
              selectedNodeId: selectedParent?.nodeId,
              selectedBranch: selectedParent?.branch,
              selectedLiveNodeId: selectedLive?.nodeId,
              selectedLiveBranch: selectedLive?.branch,
              candidates: liveCandidates.slice(0, 5),
              parentCandidates: parentCandidates.slice(0, 5),
            },
          },
        },
      };
      return appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.CACHE_BEFORE_BUILD_EVALUATED,
        source: "module-cache",
        at: new Date().toISOString(),
        payload: {
          eligible: cacheEligible,
          selectedNodeId: selectedParent?.nodeId,
          selectedBranch: selectedParent?.branch,
          selectedLiveNodeId: selectedLive?.nodeId,
          selectedLiveBranch: selectedLive?.branch,
          candidateCount: liveCandidates.length,
          parentCandidateCount: parentCandidates.length,
        },
      });
    },
    async afterCall(ctx, result) {
      const cacheMeta = (ctx.metadata?.cache ?? {}) as Record<string, unknown>;
      const eligible = Boolean(cacheMeta.eligible);
      if (!eligible) {
        return appendResultEvent(result, {
          type: ECOCLAW_EVENT_TYPES.CACHE_AFTER_CALL_SKIPPED,
          source: "module-cache",
          at: new Date().toISOString(),
          payload: { reason: "not-eligible" },
        });
      }
      const selectedNodeId = (cacheMeta.tree as Record<string, unknown> | undefined)?.selectedNodeId;
      const snapshot = {
        sessionId: ctx.sessionId,
        provider: ctx.provider,
        model: ctx.model,
        createdAt: new Date().toISOString(),
        prefixSignature: String(cacheMeta.prefixSignature ?? ""),
        prefixSignatureNormalized: String(cacheMeta.prefixSignatureNormalized ?? ""),
        contextSignature: signature(ctx.prompt),
        contextChars: ctx.prompt.length,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        cacheReadTokens: result.usage?.cacheReadTokens ?? result.usage?.cachedTokens,
        cacheWriteTokens: result.usage?.cacheWriteTokens,
      };
      const summaryReadyEvents = findRuntimeEventsByType(
        result.metadata,
        ECOCLAW_EVENT_TYPES.SUMMARY_GENERATED,
      );
      const summaryHint = summaryReadyEvents[summaryReadyEvents.length - 1];
      const node = tree.registerTurn({
        snapshot,
        preferredParentId: typeof selectedNodeId === "string" ? selectedNodeId : undefined,
        branch:
          typeof (summaryHint?.payload as Record<string, unknown> | undefined)?.targetBranch === "string"
            ? String((summaryHint?.payload as Record<string, unknown>)?.targetBranch)
            : undefined,
      });
      const readTokens = result.usage?.cacheReadTokens ?? result.usage?.cachedTokens;
      if ((readTokens ?? 0) > 0) {
        // Cache read hit should refresh the matched ancestor path, not the freshly appended node.
        if (typeof selectedNodeId === "string") {
          tree.markHitPath(ctx.sessionId, selectedNodeId);
        } else {
          tree.markHit(ctx.sessionId, node.id);
        }
      }
      tree.pruneExpired(ctx.sessionId);
      const nextResult = {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          cache: {
            ...(result.metadata?.cache ?? {}),
            treeNodeId: node.id,
            branch: node.branch,
            expiresAt: node.expiresAt,
            hitCount: node.hitCount,
          },
        },
      };
      return appendResultEvent(nextResult, {
        type: ECOCLAW_EVENT_TYPES.CACHE_AFTER_CALL_RECORDED,
        source: "module-cache",
        at: new Date().toISOString(),
        payload: {
          nodeId: node.id,
          parentId: node.parentId,
          branch: node.branch,
          expiresAt: node.expiresAt,
          hitCount: node.hitCount,
          readTokens: typeof readTokens === "number" ? readTokens : undefined,
        },
      });
    },
  };
}

export { CacheTreeManager } from "./manager.js";
export type {
  CacheCandidateFilter,
  CacheBranchCandidate,
  CacheNode,
  CacheNodeId,
  CacheTreeOptions,
  CacheTreeRegisterInput,
  CacheTreeSnapshot,
  CacheTreeState,
} from "./types.js";
