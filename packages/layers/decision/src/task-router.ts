import { resolveApiFamily, type ApiFamily, type RuntimeModule } from "@ecoclaw/kernel";
import type {
  LlmRouter,
  RoutingDecision,
  RoutingFeatures,
  RoutingTier,
  TaskRouterConfig,
} from "./types.js";

const CODE_HINTS = [
  "code",
  "debug",
  "fix",
  "bug",
  "refactor",
  "typescript",
  "python",
  "javascript",
  "sql",
  "regex",
];

const REASONING_HINTS = [
  "prove",
  "derive",
  "step by step",
  "reason",
  "trade-off",
  "compare",
  "complex",
  "analyze",
];

const TOOL_HINTS = [
  "run",
  "execute",
  "shell",
  "terminal",
  "command",
  "file",
  "search",
  "benchmark",
];

function includesAny(text: string, hints: string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

function extractFeatures(
  apiFamily: ApiFamily,
  prompt: string,
  segmentCount: number,
  stableSegmentCount: number,
): RoutingFeatures {
  const lower = prompt.toLowerCase();
  const promptWords = prompt.trim().split(/\s+/).filter(Boolean).length;
  return {
    apiFamily,
    promptChars: prompt.length,
    promptWords,
    hasCodeIntent: includesAny(lower, CODE_HINTS),
    hasReasoningIntent: includesAny(lower, REASONING_HINTS),
    hasToolIntent: includesAny(lower, TOOL_HINTS),
    segmentCount,
    stableSegmentCount,
  };
}

function defaultDecision(features: RoutingFeatures, defaultTier: RoutingTier): RoutingDecision {
  // Lightweight heuristic compatible with single-turn OpenClaw runtime.
  if (features.apiFamily === "openai-responses" && features.hasReasoningIntent) {
    return {
      tier: "reasoning",
      reason: "heuristic:responses_reasoning_priority",
      confidence: 0.8,
    };
  }
  if (features.hasReasoningIntent || features.promptWords > 240) {
    return {
      tier: "reasoning",
      reason: "heuristic:reasoning_or_long_prompt",
      confidence: 0.76,
    };
  }
  if (features.hasCodeIntent || features.hasToolIntent || features.promptWords > 120) {
    return {
      tier: "complex",
      reason: "heuristic:code_tool_or_mid_long_prompt",
      confidence: 0.7,
    };
  }
  if (features.promptWords > 35 || features.segmentCount > 6) {
    return {
      tier: "standard",
      reason: "heuristic:multi_clause_prompt",
      confidence: 0.64,
    };
  }
  return {
    tier: defaultTier,
    reason: "heuristic:default",
    confidence: 0.6,
  };
}

export type {
  LlmRouter,
  RoutingDecision,
  RoutingFeatures,
  RoutingTier,
  TierRouteConfig,
  TaskRouterConfig,
} from "./types.js";

export function createTaskRouterModule(cfg: TaskRouterConfig = {}): RuntimeModule {
  const enabled = cfg.enabled ?? false;
  const smallTaskTokenBudget = cfg.smallTaskTokenBudget ?? 2000;
  const defaultTier = cfg.defaultTier ?? "simple";
  const router: LlmRouter | undefined =
    typeof cfg.router === "function" ? { resolve: cfg.router } : cfg.router;

  return {
    name: "module-task-router",
    async beforeCall(ctx) {
      if (!enabled) return ctx;

      const stableSegmentCount = ctx.segments.filter((s) => s.kind === "stable").length;
      const apiFamily = resolveApiFamily(ctx);
      const features = extractFeatures(apiFamily, ctx.prompt, ctx.segments.length, stableSegmentCount);
      const baseDecision = router
        ? await router.resolve(ctx, features)
        : defaultDecision(features, defaultTier);

      const tierRoute = cfg.tierRoutes?.[baseDecision.tier];
      const nextProvider = baseDecision.provider ?? tierRoute?.provider ?? ctx.provider;
      const nextModel = baseDecision.model ?? tierRoute?.model ?? ctx.model;
      const fallbackModels = baseDecision.fallbackModels ?? tierRoute?.fallbackModels ?? [];

      const routeChanged = nextProvider !== ctx.provider || nextModel !== ctx.model;

      return {
        ...ctx,
        provider: nextProvider,
        model: nextModel,
        apiFamily,
        metadata: {
          ...(ctx.metadata ?? {}),
          taskRouter: {
            decision: routeChanged ? "rerouted" : "kept",
            tier: baseDecision.tier,
            reason: baseDecision.reason,
            confidence: baseDecision.confidence,
            score: baseDecision.score,
            from: { provider: ctx.provider, model: ctx.model },
            to: { provider: nextProvider, model: nextModel },
            fallbackModels,
            features,
            smallTaskTokenBudget,
            metadata: baseDecision.metadata ?? {},
          },
        },
      };
    },
  };
}
