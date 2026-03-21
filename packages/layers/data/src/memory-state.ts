import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  findRuntimeEventsByType,
  type RuntimeModule,
} from "@ecoclaw/kernel";

type MemoryStateEntry = {
  seedText: string;
  summaryText: string;
  recentMessages?: Array<{
    index?: number;
    at?: string;
    user?: string;
    assistant?: string;
  }>;
  updatedAt: string;
  source: string;
};

export type MemoryStateModuleConfig = {
  maxSummaryChars?: number;
};

export function createMemoryStateModule(cfg: MemoryStateModuleConfig = {}): RuntimeModule {
  const maxSummaryChars = Math.max(200, cfg.maxSummaryChars ?? 2000);
  const stateBySession = new Map<string, MemoryStateEntry>();

  return {
    name: "module-memory-state",
    async beforeBuild(ctx) {
      const state = stateBySession.get(ctx.sessionId);
      if (!state) return ctx;
      const nextCtx = {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          memoryState: {
            hasSeed: true,
            updatedAt: state.updatedAt,
            source: state.source,
          },
        },
      };
      return appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.MEMORY_SEED_AVAILABLE,
        source: "module-memory-state",
        at: new Date().toISOString(),
        payload: {
          updatedAt: state.updatedAt,
          source: state.source,
          summaryPreview: state.seedText.slice(0, 200),
          recentMessageCount: state.recentMessages?.length ?? 0,
        },
      });
    },
    async afterCall(ctx, result) {
      const events = findRuntimeEventsByType(
        result.metadata,
        ECOCLAW_EVENT_TYPES.SUMMARY_GENERATED,
      );
      if (events.length === 0) return result;
      const latest = events[events.length - 1];
      const payload = latest.payload as Record<string, unknown> | undefined;
      const rawSummary = String(payload?.summaryText ?? "");
      const summaryText = rawSummary.length > maxSummaryChars
        ? `${rawSummary.slice(0, maxSummaryChars)}\n...[truncated]`
        : rawSummary;
      const recentMessages = Array.isArray(payload?.recentMessages)
        ? (payload?.recentMessages as Array<{
            index?: number;
            at?: string;
            user?: string;
            assistant?: string;
          }>)
        : [];
      const recentMessagesText = recentMessages
        .map(
          (item, idx) =>
            `[${item.index ?? idx + 1}] ${item.at ?? ""}\nUSER: ${item.user ?? ""}\nASSISTANT: ${item.assistant ?? ""}`,
        )
        .join("\n\n");
      const seedText = recentMessagesText
        ? `${summaryText}\n\n## Recent Raw Messages\n${recentMessagesText}`
        : summaryText;
      const updatedAt = new Date().toISOString();
      stateBySession.set(ctx.sessionId, {
        seedText,
        summaryText,
        recentMessages,
        updatedAt,
        source: "module-summary",
      });
      return appendResultEvent(
        {
          ...result,
          metadata: {
            ...(result.metadata ?? {}),
            memoryState: {
              hasSeed: true,
              updatedAt,
              source: "module-summary",
            },
          },
        },
        {
          type: ECOCLAW_EVENT_TYPES.MEMORY_STATE_UPDATED,
          source: "module-memory-state",
          at: updatedAt,
          payload: {
            updatedAt,
            source: "module-summary",
            summaryChars: summaryText.length,
            seedChars: seedText.length,
            recentMessageCount: recentMessages.length,
          },
        },
      );
    },
  };
}
