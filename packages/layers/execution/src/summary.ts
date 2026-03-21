import {
  ECOCLAW_EVENT_TYPES,
  appendResultEvent,
  findRuntimeEventsByType,
  type RuntimeModule,
} from "@ecoclaw/kernel";

export type SummaryModuleConfig = {
  idleTriggerMinutes?: number;
  recentTurns?: number;
  compactionPrompt?: string;
  resumePrefixPrompt?: string;
};

type TurnSnapshot = {
  at: string;
  user: string;
  assistant: string;
  provider: string;
  model: string;
};

const DEFAULT_COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION.
Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM
seamlessly continue the work.`;

const DEFAULT_RESUME_PREFIX_PROMPT = `Another language model started to solve this problem and produced
a summary of its thinking process. You also have access to the
state of the tools that were used by that language model. Use this
to build on the work that has already been done and avoid
duplicating work. Here is the summary produced by the other
language model, use the information in this summary to assist
with your own analysis:`;

export function createSummaryModule(cfg: SummaryModuleConfig = {}): RuntimeModule {
  const idleTriggerMinutes = cfg.idleTriggerMinutes ?? 50;
  const recentTurns = Math.max(1, cfg.recentTurns ?? 6);
  const compactionPrompt = (cfg.compactionPrompt ?? DEFAULT_COMPACTION_PROMPT).trim();
  const resumePrefixPrompt = (cfg.resumePrefixPrompt ?? DEFAULT_RESUME_PREFIX_PROMPT).trim();
  const turnState = new Map<string, TurnSnapshot[]>();

  return {
    name: "module-summary",
    async afterCall(ctx, result) {
      const turns = turnState.get(ctx.sessionId) ?? [];
      turns.push({
        at: new Date().toISOString(),
        user: ctx.prompt,
        assistant: result.content,
        provider: ctx.provider,
        model: ctx.model,
      });
      const clippedTurns = turns.slice(-Math.max(2, recentTurns * 3));
      turnState.set(ctx.sessionId, clippedTurns);

      const policyEvents = findRuntimeEventsByType(
        ctx.metadata,
        ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED,
      );
      const requested = policyEvents.length > 0;
      const stableText = ctx.segments
        .filter((s) => s.kind === "stable")
        .map((s) => s.text)
        .join("\n");
      const volatileText = ctx.segments
        .filter((s) => s.kind !== "stable")
        .map((s) => s.text)
        .join("\n");
      const recent = clippedTurns.slice(-recentTurns);
      const progress = recent.slice(-2).map((t) => t.assistant.slice(0, 180));
      const nextAction = recent.length > 0 ? recent[recent.length - 1]?.user.slice(0, 220) : ctx.prompt.slice(0, 220);
      const latestProvider = recent[recent.length - 1]?.provider ?? ctx.provider;
      const latestModel = recent[recent.length - 1]?.model ?? ctx.model;
      const recentRaw = recent.map((t, idx) => ({
        index: idx + 1,
        at: t.at,
        user: t.user.slice(0, 400),
        assistant: t.assistant.slice(0, 400),
      }));
      const recentRawText = recentRaw
        .map(
          (t) =>
            `[${t.index}] at=${t.at}\nUSER: ${t.user}\nASSISTANT: ${t.assistant}`,
        )
        .join("\n\n");

      const summaryText = [
        "## Current Progress",
        ...progress.map((p, idx) => `- ${idx + 1}. ${p}`),
        progress.length === 0 ? "- No completed progress captured yet." : "",
        "",
        "## Key Decisions",
        `- Runtime provider/model: ${latestProvider}/${latestModel}`,
        `- Stable context chars: ${stableText.length}`,
        `- Volatile context chars: ${volatileText.length}`,
        "",
        "## Constraints and Preferences",
        "- Preserve user intent and avoid duplicate work.",
        "- Prefer concise, execution-oriented continuation.",
        "",
        "## Remaining Next Steps",
        `- Continue from latest user intent: ${nextAction}`,
        "- Reuse recent outputs and avoid recomputing completed steps.",
        "",
        "## Critical References",
        "- Use recent raw messages below as authoritative short-term context.",
        "",
        "## Recent Raw Messages",
        recentRawText || "(none)",
      ]
        .filter(Boolean)
        .join("\n");

      const nextResult = {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          summary: {
            idleTriggerMinutes,
            requestedByPolicy: requested,
            compactionPrompt,
            resumePrefixPrompt,
            recentTurns,
            recentRawMessages: recentRaw,
            summaryText,
          },
        },
      };
      if (!requested) {
        return nextResult;
      }
      return appendResultEvent(nextResult, {
        type: ECOCLAW_EVENT_TYPES.SUMMARY_GENERATED,
        source: "module-summary",
        at: new Date().toISOString(),
        payload: {
          summaryText,
          compactionPrompt,
          resumePrefixPrompt,
          recentMessages: recentRaw,
          targetBranch: `compact-${Date.now()}`,
          seedMode: "summary",
        },
      });
    },
  };
}
