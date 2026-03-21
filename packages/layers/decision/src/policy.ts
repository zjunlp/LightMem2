import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  findRuntimeEventsByType,
  resolveApiFamily,
  type RuntimeTurnContext,
  type RuntimeModule,
} from "@ecoclaw/kernel";

export type PolicyModuleConfig = {
  summaryTriggerInputTokens?: number;
  summaryTriggerStableChars?: number;
  ttlSoonSeconds?: number;
  cacheJitterWindowTurns?: number;
  cacheMissRateThreshold?: number;
  minTurnsBeforeJitter?: number;
  requestCooldownTurns?: number;
  cacheProbeEnabled?: boolean;
  cacheProbeIntervalSeconds?: number;
  cacheProbeMaxPromptChars?: number;
  cacheProbeHitMinTokens?: number;
  cacheProbeMissesToCold?: number;
  cacheProbeWarmSeconds?: number;
};

export function createPolicyModule(cfg: PolicyModuleConfig = {}): RuntimeModule {
  const summaryTriggerInputTokens = Math.max(0, cfg.summaryTriggerInputTokens ?? 20000);
  const summaryTriggerStableChars = Math.max(0, cfg.summaryTriggerStableChars ?? 0);
  const ttlSoonSeconds = Math.max(10, cfg.ttlSoonSeconds ?? 120);
  const cacheJitterWindowTurns = Math.max(3, cfg.cacheJitterWindowTurns ?? 6);
  const cacheMissRateThreshold = Math.min(1, Math.max(0, cfg.cacheMissRateThreshold ?? 0.5));
  const minTurnsBeforeJitter = Math.max(1, cfg.minTurnsBeforeJitter ?? 4);
  const requestCooldownTurns = Math.max(0, cfg.requestCooldownTurns ?? 2);
  const cacheProbeEnabled = cfg.cacheProbeEnabled ?? true;
  const cacheProbeIntervalSeconds = Math.max(30, cfg.cacheProbeIntervalSeconds ?? 1800);
  const cacheProbeMaxPromptChars = Math.max(1, cfg.cacheProbeMaxPromptChars ?? 120);
  const cacheProbeHitMinTokens = Math.max(0, cfg.cacheProbeHitMinTokens ?? 64);
  const cacheProbeMissesToCold = Math.max(1, cfg.cacheProbeMissesToCold ?? 2);
  const cacheProbeWarmSeconds = Math.max(30, cfg.cacheProbeWarmSeconds ?? 7200);
  type ProbeMode = "warm" | "uncertain" | "cold";
  const stateBySession = new Map<
    string,
    {
      turn: number;
      lastSummaryRequestTurn?: number;
      recentCacheReadHit: number[];
      cumulativeInputTokens: number;
      probe: {
        mode: ProbeMode;
        lastProbeAtMs?: number;
        lastProbeHitAtMs?: number;
        lastProbeReadTokens?: number;
        consecutiveProbeMisses: number;
      };
    }
  >();

  const readInputTokens = (usage: any): number => {
    const toNum = (value: unknown): number | undefined => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
      }
      return undefined;
    };
    const direct = toNum(usage?.inputTokens);
    if (direct !== undefined) return direct;
    const raw = usage?.providerRaw as Record<string, unknown> | undefined;
    const rawInput = toNum(raw?.input_tokens ?? raw?.prompt_tokens ?? raw?.inputTokens ?? raw?.promptTokens);
    return rawInput ?? 0;
  };

  return {
    name: "module-policy",
    async beforeBuild(ctx) {
      const apiFamily = resolveApiFamily(ctx);
      const state = stateBySession.get(ctx.sessionId) ?? {
        turn: 0,
        recentCacheReadHit: [],
        cumulativeInputTokens: 0,
        probe: {
          mode: "uncertain" as ProbeMode,
          consecutiveProbeMisses: 0,
        },
      };
      const nowMs = Date.now();
      const stableChars = ctx.segments
        .filter((s) => s.kind === "stable")
        .map((s) => s.text)
        .join("\n").length;
      const cacheMeta = (ctx.metadata?.cache as Record<string, unknown> | undefined) ?? {};
      const cacheEligible = Boolean(cacheMeta.eligible);
      const treeMeta = (cacheMeta.tree as Record<string, unknown> | undefined) ?? {};
      const selectedCandidate = Array.isArray(treeMeta.candidates) ? treeMeta.candidates[0] : undefined;
      const selectedExpiresAt = (selectedCandidate as Record<string, unknown> | undefined)?.expiresAt;
      const expiresSoon =
        typeof selectedExpiresAt === "string"
          ? new Date(selectedExpiresAt).getTime() - Date.now() <= ttlSoonSeconds * 1000
          : false;

      const recent = state.recentCacheReadHit.slice(-cacheJitterWindowTurns);
      const missCount = recent.filter((v) => v === 0).length;
      const missRate = recent.length > 0 ? missCount / recent.length : 0;
      const jitterTriggered =
        state.turn >= minTurnsBeforeJitter &&
        recent.length >= Math.min(cacheJitterWindowTurns, minTurnsBeforeJitter) &&
        missRate >= cacheMissRateThreshold;

      const lastProbeAtMs = state.probe.lastProbeAtMs;
      const probeSupported = apiFamily !== "openai-completions";
      const probeDue =
        cacheProbeEnabled &&
        probeSupported &&
        cacheEligible &&
        (lastProbeAtMs == null || nowMs - lastProbeAtMs >= cacheProbeIntervalSeconds * 1000);
      const promptChars = String(ctx.prompt ?? "").length;
      const probePlanned = probeDue && promptChars <= cacheProbeMaxPromptChars;
      const hitFresh =
        typeof state.probe.lastProbeHitAtMs === "number" &&
        nowMs - state.probe.lastProbeHitAtMs <= cacheProbeWarmSeconds * 1000;
      let probeMode: ProbeMode = state.probe.mode;
      if (hitFresh) {
        probeMode = "warm";
      } else if (state.probe.consecutiveProbeMisses >= cacheProbeMissesToCold) {
        probeMode = "cold";
      } else {
        probeMode = "uncertain";
      }
      state.probe.mode = probeMode;

      const reasons: string[] = [];
      if (cacheEligible && summaryTriggerInputTokens > 0 && state.cumulativeInputTokens >= summaryTriggerInputTokens) {
        reasons.push("input_tokens_threshold");
      }
      if (cacheEligible && summaryTriggerStableChars > 0 && stableChars >= summaryTriggerStableChars) {
        reasons.push("stable_chars_threshold");
      }
      if (cacheEligible && expiresSoon) {
        reasons.push("cache_ttl_soon");
      }
      if (cacheEligible && jitterTriggered) {
        reasons.push("cache_jitter");
      }
      if (cacheEligible && probeSupported && probeMode === "cold" && !probePlanned) {
        reasons.push("cache_probe_cold");
      }
      const shouldRequestSummary = reasons.length > 0;
      const cooldownActive =
        typeof state.lastSummaryRequestTurn === "number" &&
        state.turn - state.lastSummaryRequestTurn <= requestCooldownTurns;
      const finalRequest = shouldRequestSummary && !cooldownActive;

      const withMeta = {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          policy: {
            apiFamily,
            summaryTriggerInputTokens,
            summaryTriggerStableChars,
            ttlSoonSeconds,
            cacheJitterWindowTurns,
            cacheMissRateThreshold,
            stableChars,
            cumulativeInputTokens: state.cumulativeInputTokens,
            shouldRequestSummary: finalRequest,
            reasons,
            recentCacheMissRate: missRate,
            cacheExpiresSoon: expiresSoon,
            cooldownActive,
            cacheProbe: {
              enabled: cacheProbeEnabled,
              supported: probeSupported,
              mode: probeMode,
              probeDue,
              probePlanned,
              probeIntervalSeconds: cacheProbeIntervalSeconds,
              probeMaxPromptChars: cacheProbeMaxPromptChars,
              probeHitMinTokens: cacheProbeHitMinTokens,
              probeMissesToCold: cacheProbeMissesToCold,
              probeWarmSeconds: cacheProbeWarmSeconds,
              promptChars,
              lastProbeAtMs: state.probe.lastProbeAtMs,
              lastProbeReadTokens: state.probe.lastProbeReadTokens,
              consecutiveProbeMisses: state.probe.consecutiveProbeMisses,
              hitFresh,
            },
          },
        },
      };
      let nextCtx: RuntimeTurnContext = withMeta;
      if (cacheEligible && cacheProbeEnabled && probeSupported) {
        nextCtx = appendContextEvent(nextCtx, {
          type: ECOCLAW_EVENT_TYPES.POLICY_CACHE_PROBE_DECIDED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            mode: probeMode,
            probeDue,
            probePlanned,
            promptChars,
            maxPromptChars: cacheProbeMaxPromptChars,
            intervalSeconds: cacheProbeIntervalSeconds,
            consecutiveProbeMisses: state.probe.consecutiveProbeMisses,
            hitFresh,
            apiFamily,
          },
        });
      }
      if (jitterTriggered) {
        nextCtx = appendContextEvent(nextCtx, {
          type: ECOCLAW_EVENT_TYPES.POLICY_CACHE_JITTER_DETECTED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            missRate,
            missCount,
            recentWindowSize: recent.length,
            threshold: cacheMissRateThreshold,
            apiFamily,
          },
        });
      }
      if (!finalRequest) {
        return nextCtx;
      }
      state.lastSummaryRequestTurn = state.turn;
      stateBySession.set(ctx.sessionId, state);
      return appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED,
        source: "module-policy",
        at: new Date().toISOString(),
        payload: {
          cumulativeInputTokens: state.cumulativeInputTokens,
          stableChars,
          reasons,
          inputTokensThreshold: summaryTriggerInputTokens,
          threshold: summaryTriggerStableChars,
          ttlSoonSeconds,
          missRate,
          apiFamily,
        },
      });
    },
    async afterCall(ctx, result) {
      const apiFamily = resolveApiFamily(ctx);
      const state = stateBySession.get(ctx.sessionId) ?? {
        turn: 0,
        recentCacheReadHit: [],
        cumulativeInputTokens: 0,
        probe: {
          mode: "uncertain" as ProbeMode,
          consecutiveProbeMisses: 0,
        },
      };
      state.turn += 1;
      const rawReadTokens = result.usage?.cacheReadTokens ?? result.usage?.cachedTokens;
      const hasReadSignal = typeof rawReadTokens === "number" && Number.isFinite(rawReadTokens);
      const readTokens = hasReadSignal ? Number(rawReadTokens) : 0;
      state.cumulativeInputTokens += readInputTokens(result.usage);
      if (hasReadSignal) {
        state.recentCacheReadHit.push(readTokens > 0 ? 1 : 0);
        if (state.recentCacheReadHit.length > cacheJitterWindowTurns * 3) {
          state.recentCacheReadHit = state.recentCacheReadHit.slice(-cacheJitterWindowTurns * 3);
        }
      }
      stateBySession.set(ctx.sessionId, state);

      const policyMeta = (ctx.metadata?.policy as Record<string, unknown> | undefined) ?? {};
      const probeMeta = (policyMeta.cacheProbe as Record<string, unknown> | undefined) ?? {};
      const probePlanned = Boolean(probeMeta.probePlanned);
      const probeSupported = Boolean(probeMeta.supported ?? true);
      if (cacheProbeEnabled && probeSupported && probePlanned && hasReadSignal) {
        const nowMs = Date.now();
        const hit = readTokens >= cacheProbeHitMinTokens;
        state.probe.lastProbeAtMs = nowMs;
        state.probe.lastProbeReadTokens = readTokens;
        if (hit) {
          state.probe.lastProbeHitAtMs = nowMs;
          state.probe.consecutiveProbeMisses = 0;
          state.probe.mode = "warm";
        } else {
          state.probe.consecutiveProbeMisses += 1;
          state.probe.mode =
            state.probe.consecutiveProbeMisses >= cacheProbeMissesToCold ? "cold" : "uncertain";
        }
        stateBySession.set(ctx.sessionId, state);
        result = appendResultEvent(result, {
          type: ECOCLAW_EVENT_TYPES.POLICY_CACHE_PROBE_RESULT,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            planned: true,
            hit,
            readTokens,
            hasReadSignal,
            hitMinTokens: cacheProbeHitMinTokens,
            mode: state.probe.mode,
            consecutiveProbeMisses: state.probe.consecutiveProbeMisses,
            apiFamily,
          },
        });
      }

      const summaryEvents = findRuntimeEventsByType(result.metadata, ECOCLAW_EVENT_TYPES.SUMMARY_GENERATED);
      if (summaryEvents.length === 0) return result;
      const latest = summaryEvents[summaryEvents.length - 1];
      return appendResultEvent(result, {
        type: ECOCLAW_EVENT_TYPES.POLICY_FORK_RECOMMENDED,
        source: "module-policy",
        at: new Date().toISOString(),
        payload: {
          strategy: "fork_from_summary",
          targetBranch: (latest.payload as Record<string, unknown>)?.targetBranch,
          apiFamily,
        },
      });
    },
  };
}
