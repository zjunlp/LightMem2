import { randomUUID } from "node:crypto";
import { createCacheModule, createSummaryModule, createCompressionModule } from "@ecoclaw/layer-execution";
import { openaiAdapter } from "@ecoclaw/provider-openai";
import { createOpenClawConnector } from "@ecoclaw/layer-orchestration";
import type { RuntimeTurnContext, RuntimeTurnResult } from "@ecoclaw/kernel";

type PhysicalSession = {
  id: string;
  branch: string;
  summarySeed?: string;
};

type LogicalState = {
  logicalId: string;
  active: PhysicalSession;
  turnCount: number;
  history: Array<{ role: "user" | "assistant"; content: string }>;
};

class LogicalSessionRouter {
  private readonly states = new Map<string, LogicalState>();
  private readonly physicalTurnCount = new Map<string, number>();

  ensure(logicalId: string): LogicalState {
    const existing = this.states.get(logicalId);
    if (existing) return existing;
    const initial: LogicalState = {
      logicalId,
      active: { id: `phy-${randomUUID().slice(0, 8)}`, branch: "main" },
      turnCount: 0,
      history: [],
    };
    this.states.set(logicalId, initial);
    return initial;
  }

  shouldCompact(state: LogicalState): boolean {
    return state.turnCount > 0 && state.turnCount % 3 === 0;
  }

  buildSummary(state: LogicalState): string {
    const userFacts = state.history
      .filter((h) => h.role === "user")
      .slice(-3)
      .map((h, i) => `- user_need_${i + 1}: ${h.content.slice(0, 80)}`);
    const assistantFacts = state.history
      .filter((h) => h.role === "assistant")
      .slice(-2)
      .map((h, i) => `- done_${i + 1}: ${h.content.slice(0, 80)}`);
    return [
      "Compact summary for forked session:",
      ...userFacts,
      ...assistantFacts,
      "- policy: preserve user intent and pending tasks",
    ].join("\n");
  }

  forkFromSummary(logicalId: string, summary: string): { from: PhysicalSession; to: PhysicalSession } {
    const state = this.ensure(logicalId);
    const from = state.active;
    const to: PhysicalSession = {
      id: `phy-${randomUUID().slice(0, 8)}`,
      branch: `${from.branch}.fork${state.turnCount / 3}`,
      summarySeed: summary,
    };
    state.active = to;
    return { from, to };
  }

  noteTurn(logicalId: string, user: string, assistant: string): void {
    const state = this.ensure(logicalId);
    state.turnCount += 1;
    state.history.push({ role: "user", content: user });
    state.history.push({ role: "assistant", content: assistant });
  }

  incPhysicalTurn(physicalId: string): number {
    const now = (this.physicalTurnCount.get(physicalId) ?? 0) + 1;
    this.physicalTurnCount.set(physicalId, now);
    return now;
  }
}

function buildContext(logicalId: string, physical: PhysicalSession, message: string): RuntimeTurnContext {
  const stableParts = [
    "SOUL.md: You are a practical daily assistant.",
    "USER.md: User prefers concise, execution-focused answers.",
    "AGENTS.md: Use tools when necessary and report outcomes clearly.",
  ];
  if (physical.summarySeed) {
    stableParts.push(`MEMORY_COMPACT.md:\n${physical.summarySeed}`);
  }

  return {
    sessionId: physical.id,
    sessionMode: "cross",
    provider: "openai",
    model: "gpt-5.4",
    prompt: message,
    segments: [
      {
        id: `${logicalId}-stable`,
        kind: "stable",
        text: stableParts.join("\n\n"),
        priority: 1,
      },
      {
        id: `${logicalId}-volatile-${Date.now()}`,
        kind: "volatile",
        text: message,
        priority: 10,
      },
    ],
    budget: {
      maxInputTokens: 16000,
      reserveOutputTokens: 1200,
    },
    metadata: {
      logicalSessionId: logicalId,
      physicalSessionId: physical.id,
      branch: physical.branch,
      seedSummary: Boolean(physical.summarySeed),
    },
  };
}

function fakeInvokeModelFactory(router: LogicalSessionRouter) {
  return async (ctx: RuntimeTurnContext): Promise<RuntimeTurnResult> => {
    const physicalTurn = router.incPhysicalTurn(ctx.sessionId);
    const stableChars = ctx.segments.filter((s) => s.kind === "stable").map((s) => s.text).join("\n").length;
    const inputTokens = Math.round((ctx.prompt.length + stableChars) * 0.33);
    const outputTokens = 120 + Math.round(ctx.prompt.length * 0.08);
    const cached = physicalTurn === 1 ? 0 : Math.max(0, Math.round(stableChars * 0.25));

    return {
      content: `(${ctx.sessionId}) 已处理: ${ctx.prompt}`,
      usage: {
        providerRaw: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          prompt_tokens_details: { cached_tokens: cached },
        },
      },
    };
  };
}

async function main() {
  const connector = createOpenClawConnector({
    modules: [
      createCacheModule({ minPrefixChars: 120, tree: { ttlSeconds: 600, defaultBranch: "main" } }),
      createSummaryModule({ idleTriggerMinutes: 15 }),
      createCompressionModule({ maxToolChars: 600 }),
    ],
    adapters: { openai: openaiAdapter },
    stateDir: "/tmp/ecoclaw-demo-state",
  });
  const router = new LogicalSessionRouter();
  const invokeModel = fakeInvokeModelFactory(router);

  const logicalId = "tui-chat-001";
  const userTurns = [
    "帮我做今天的学习计划，重点是系统设计和代码实践。",
    "再加上晚上30分钟英语口语练习。",
    "把这个计划改成可打卡格式。",
    "顺便给我一个明天的简版。",
    "把明天版本压缩到3条。",
  ];

  console.log(`\n[TUI] Enter chat window: logical_session=${logicalId}\n`);
  for (const userMessage of userTurns) {
    const state = router.ensure(logicalId);
    const physical = state.active;
    const turnCtx = buildContext(logicalId, physical, userMessage);
    const result = await connector.onLlmCall(turnCtx, invokeModel);
    const cacheMeta = (result.metadata?.cache ?? {}) as Record<string, unknown>;

    router.noteTurn(logicalId, userMessage, result.content);
    console.log(`[TUI] user(${logicalId}): ${userMessage}`);
    console.log(
      `[TUI] assistant(${logicalId}): ${result.content} | physical=${physical.id} branch=${physical.branch} cacheNode=${String(cacheMeta.treeNodeId ?? "-")}`,
    );

    if (router.shouldCompact(state)) {
      const summary = router.buildSummary(state);
      await connector.writeSessionSummary(physical.id, summary, "cachetree-compact");
      const switched = router.forkFromSummary(logicalId, summary);
      console.log(
        `[router] compact+fork (user invisible): ${switched.from.id} -> ${switched.to.id} (${switched.to.branch})`,
      );

      // Seed first turn in new physical session using compact summary.
      const seedCtx = buildContext(logicalId, switched.to, "[seed] Continue from compact summary.");
      await connector.onLlmCall(seedCtx, invokeModel);
      console.log(`[router] seeded new physical session: ${switched.to.id}\n`);
    }
  }

  console.log("[done] Demo complete. User always stayed in one logical TUI chat.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
