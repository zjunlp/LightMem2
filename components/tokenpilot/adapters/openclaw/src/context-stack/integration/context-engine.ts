/* eslint-disable @typescript-eslint/no-explicit-any */
import { rewriteCanonicalState, syncCanonicalStateFromTranscript } from "../page-out/canonical-rewrite-adapter.js";
import { estimateMessagesChars, saveCanonicalState } from "@tokenpilot/history";
import { appendModuleObservation } from "@tokenpilot/product-surface";
import { enqueueEvictedTasksForProceduralMemory } from "./procedural-memory.js";
import { runHistoryEvictionIfEnabled } from "./history-eviction-runner.js";
import { runHistoryModules } from "./module-orchestrator.js";

export function createPluginContextEngine(cfg: any, logger: any, deps: any) {
  const canonicalMessageTaskIdsBound = (message: Record<string, unknown>): string[] =>
    deps.canonicalMessageTaskIds(message, deps.asRecord);

  async function syncAndEvict(sessionId: string) {
    const context: {
      synced?: Awaited<ReturnType<typeof syncCanonicalStateFromTranscript>>;
      eviction?: Awaited<ReturnType<typeof runHistoryEvictionIfEnabled>>;
    } = {};
    const historyModuleExecutions = await runHistoryModules({
      context,
      modules: [
        {
          id: "canonical-sync",
          enabled: () => true,
          run: async () => {
            context.synced = await syncCanonicalStateFromTranscript({
              stateDir: cfg.stateDir,
              sessionId,
              getMessage: (entry: any) => entry.message,
              helpers: {
                appendTaskStateTrace: deps.appendTaskStateTrace,
                readTranscriptEntriesForSession: deps.readTranscriptEntriesForSession,
                stableIdForEntry: deps.transcriptMessageStableId,
              },
            });
            return context.synced;
          },
        },
        {
          id: "eviction",
          enabled: () => cfg.moduleEnablement.eviction,
          run: async () => {
            context.eviction = await runHistoryEvictionIfEnabled({
              cfg,
              sessionId,
              state: context.synced!.state,
              helpers: {
                ...deps,
                canonicalMessageTaskIds: canonicalMessageTaskIdsBound,
              },
              logger,
              rewriteCanonicalState,
              estimateMessagesChars,
            });
            await deps.appendTaskStateTrace(cfg.stateDir, {
              stage: "history_eviction_completed",
              sessionId,
              changed: context.eviction.changed,
              appliedTaskIds: context.eviction.appliedTaskIds,
              savedChars: context.eviction.savedChars,
              diagnostics: context.eviction.diagnostics,
            });
            return context.eviction;
          },
        },
        {
          id: "memory-consumer",
          enabled: () => Boolean(context.eviction?.appliedTaskIds.length),
          run: async () => enqueueEvictedTasksForProceduralMemory({
            cfg,
            sessionId,
            state: context.eviction!.state,
            appliedTaskIds: context.eviction!.appliedTaskIds,
            helpers: deps,
            logger,
          }),
        },
        {
          id: "canonical-persistence",
          enabled: () => Boolean(context.synced?.changed || context.eviction?.changed),
          run: async () => saveCanonicalState(
            cfg.stateDir,
            context.eviction?.state ?? context.synced!.state,
          ),
        },
      ],
    });
    const synced = context.synced!;
    const eviction = context.eviction ?? await runHistoryEvictionIfEnabled({
      cfg,
      sessionId,
      state: synced.state,
      helpers: {
        ...deps,
        canonicalMessageTaskIds: canonicalMessageTaskIdsBound,
      },
      logger,
      rewriteCanonicalState,
      estimateMessagesChars,
    });
    try {
      await appendModuleObservation(cfg.stateDir, {
        sessionId,
        phase: "history",
        moduleId: "eviction",
        enabled: eviction.enabled,
        executed: historyModuleExecutions.some(
          (execution) => execution.id === "eviction" && execution.status === "executed",
        ),
        changed: eviction.changed,
        skippedReason: eviction.diagnostics.skippedReason,
        savedChars: eviction.savedChars,
        savedTokens: Math.max(0, Math.round(eviction.savedChars / 4)),
        api: { inputTokens: 0, outputTokens: 0 },
      });
    } catch (error) {
      logger.warn?.(
        `[context-engine] module observation write failed module=eviction: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      state: eviction.state,
      changed: synced.changed || eviction.changed,
      synced,
      eviction,
      historyModuleExecutions,
    };
  }

  return {
    info: {
      id: "layered-context",
      name: "Layered Context Engine",
    },
    async ingest() {
      return { ingested: false };
    },
    async afterTurn(params: { sessionId: string; messages: any[] }) {
      await syncAndEvict(params.sessionId);
    },
    async assemble(params: { sessionId: string; messages: any[]; tokenBudget?: number }) {
      const result = await syncAndEvict(params.sessionId);
      const estimatedChars = estimateMessagesChars(result.state.messages, deps.contentToText);
      return {
        messages: result.state.messages,
        estimatedTokens: Math.max(1, Math.ceil(estimatedChars / 4)),
      };
    },
    async compact(params: { sessionId: string; messages?: any[]; force?: boolean }) {
      const result = await syncAndEvict(params.sessionId);
      return {
        ok: true,
        compacted: result.changed,
        reason: result.changed
          ? "tokenpilot canonical state updated"
          : "tokenpilot canonical state unchanged",
      };
    },
  };
}
