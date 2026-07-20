/* eslint-disable @typescript-eslint/no-explicit-any */
import { rewriteCanonicalState, syncCanonicalStateFromTranscript } from "../page-out/canonical-rewrite-adapter.js";
import { estimateMessagesChars, saveCanonicalState } from "@tokenpilot/history";
import { enqueueEvictedTasksForProceduralMemory } from "./procedural-memory.js";
import { runHistoryEvictionIfEnabled } from "./history-eviction-runner.js";

export function createPluginContextEngine(cfg: any, logger: any, deps: any) {
  const canonicalMessageTaskIdsBound = (message: Record<string, unknown>): string[] =>
    deps.canonicalMessageTaskIds(message, deps.asRecord);

  async function syncAndEvict(sessionId: string) {
    const synced = await syncCanonicalStateFromTranscript({
      stateDir: cfg.stateDir,
      sessionId,
      getMessage: (entry: any) => entry.message,
      helpers: {
        appendTaskStateTrace: deps.appendTaskStateTrace,
        readTranscriptEntriesForSession: deps.readTranscriptEntriesForSession,
        stableIdForEntry: deps.transcriptMessageStableId,
      },
    });
    const eviction = await runHistoryEvictionIfEnabled({
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
    if (eviction.enabled) {
      await deps.appendTaskStateTrace(cfg.stateDir, {
        stage: "history_eviction_completed",
        sessionId,
        changed: eviction.changed,
        appliedTaskIds: eviction.appliedTaskIds,
        savedChars: eviction.savedChars,
        diagnostics: eviction.diagnostics,
      });
    }
    if (eviction.appliedTaskIds.length > 0) {
      await enqueueEvictedTasksForProceduralMemory({
        cfg,
        sessionId,
        state: eviction.state,
        appliedTaskIds: eviction.appliedTaskIds,
        helpers: deps,
        logger,
      });
    }
    if (synced.changed || eviction.changed) {
      await saveCanonicalState(cfg.stateDir, eviction.state);
    }
    return {
      state: eviction.state,
      changed: synced.changed || eviction.changed,
      synced,
      eviction,
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
