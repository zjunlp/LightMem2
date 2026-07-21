/* eslint-disable @typescript-eslint/no-explicit-any */
import { prependTextToContent } from "../request-preprocessing/root-prompt-stabilizer.js";
import { formatProceduralMemoryInjection, createLocalProceduralMemoryBackend, loadSkills, runProceduralMemoryBatch } from "@lightmem2/memory";
import {
  adaptProceduralMemoryInjection,
  createConfiguredDistiller,
  distillProviderFromConfig,
  embeddingProviderFromConfig,
} from "./procedural-memory-config.js";
import { extractLastUserPrompt, resolveTaskArchivePayloads } from "./procedural-memory-archive.js";

export async function enqueueEvictedTasksForProceduralMemory(params: {
  cfg: any;
  sessionId: string;
  state: any;
  appliedTaskIds: string[];
  helpers: any;
  logger: any;
}): Promise<{ enqueued: number; processed: number; produced: number }> {
  const evidenceMode = String(params.cfg?.taskStateEstimator?.evidenceMode ?? "three_state");
  if (
    evidenceMode === "two_state"
    || !params.cfg.memory.enabled
    || !params.cfg.memory.autoDistill
    || params.appliedTaskIds.length === 0
  ) {
    return { enqueued: 0, processed: 0, produced: 0 };
  }
  const backend = createLocalProceduralMemoryBackend(params.cfg.stateDir, {
    embeddingProvider: embeddingProviderFromConfig(params.cfg),
    distillProvider: distillProviderFromConfig(params.cfg),
  });
  const uniqueTaskIds = Array.from(new Set(params.appliedTaskIds.map((taskId) => taskId.trim()).filter(Boolean)));
  const payloads: Array<Awaited<ReturnType<typeof resolveTaskArchivePayloads>>[number]> = [];
  const archivePathCountByTask: Record<string, number> = {};
  for (const taskId of uniqueTaskIds) {
    const taskPayloads = await resolveTaskArchivePayloads({
      cfg: params.cfg,
      sessionId: params.sessionId,
      state: params.state,
      taskId,
      helpers: params.helpers,
    });
    archivePathCountByTask[taskId] = taskPayloads.length;
    payloads.push(...taskPayloads);
  }
  const enqueued = await backend.enqueue(payloads);
  let batch = { drained: 0, produced: 0, failed: 0 };
  const distillerType = String(params.cfg?.memory?.distillerType ?? "prompting").trim();
  const distiller = createConfiguredDistiller(params.cfg);
  let distillerStatus = "disabled";
  if (distiller) {
    try {
      distillerStatus = "active";
      batch = await runProceduralMemoryBatch({
      backend,
      batchSize: params.cfg.memory.batchSize,
      distiller,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      distillerStatus = "setup_failed";
      params.logger.warn?.(
        `[plugin-runtime/procedural-memory] session=${params.sessionId} distiller=${distillerType} distiller_setup_failed reason=${reason}`,
      );
    }
  } else if (distillProviderFromConfig(params.cfg)) {
    distillerStatus = "provider_missing_or_disabled";
  }
  await params.helpers.appendTaskStateTrace(params.cfg.stateDir, {
    stage: "procedural_memory_batch",
    sessionId: params.sessionId,
    distillerType,
    distillerStatus,
    enqueued,
    processed: batch.drained,
    produced: batch.produced,
    failed: batch.failed,
    taskIds: uniqueTaskIds,
    payloadCount: payloads.length,
    archivePathCountByTask,
  });
  params.logger.info(
    `[plugin-runtime/procedural-memory] session=${params.sessionId} distiller=${distillerType} status=${distillerStatus} enqueued=${enqueued} processed=${batch.drained} produced=${batch.produced} failed=${batch.failed} payloads=${payloads.length}`,
  );
  return { enqueued, processed: batch.drained, produced: batch.produced };
}

export async function injectProceduralMemoryHints(params: {
  cfg: any;
  sessionId: string;
  payload: any;
  helpers: any;
}): Promise<{ injected: boolean; hitCount: number }> {
  const evidenceMode = String(params.cfg?.taskStateEstimator?.evidenceMode ?? "three_state");
  if (evidenceMode === "two_state" || !params.cfg.memory.enabled || params.cfg.memory.topK <= 0) {
    await params.helpers.appendTaskStateTrace(params.cfg.stateDir, {
      stage: "procedural_memory_retrieval",
      sessionId: params.sessionId,
      injected: false,
      reason: evidenceMode === "two_state" ? "two_state_evidence_mode" : "disabled_or_topk_zero",
      topK: params.cfg?.memory?.topK ?? 0,
      activeTaskId: "",
      objective: "",
      hitCount: 0,
      skillIds: [],
    });
    return { injected: false, hitCount: 0 };
  }
  const objective = extractLastUserPrompt(params.payload?.input, params.helpers);
  if (!objective) {
    await params.helpers.appendTaskStateTrace(params.cfg.stateDir, {
      stage: "procedural_memory_retrieval",
      sessionId: params.sessionId,
      injected: false,
      reason: "empty_objective",
      topK: params.cfg.memory.topK,
      activeTaskId: "",
      objective,
      hitCount: 0,
      skillIds: [],
    });
    return { injected: false, hitCount: 0 };
  }

  const backend = createLocalProceduralMemoryBackend(params.cfg.stateDir, {
    embeddingProvider: embeddingProviderFromConfig(params.cfg),
    distillProvider: distillProviderFromConfig(params.cfg),
  });
  const visibleSkills = await loadSkills(params.cfg.stateDir, params.sessionId);
  const hits = await backend.retrieve({
    sessionId: params.sessionId,
    objective,
    topK: params.cfg.memory.topK,
  });
  await params.helpers.appendTaskStateTrace(params.cfg.stateDir, {
    stage: "procedural_memory_retrieval",
    sessionId: params.sessionId,
    injected: hits.length > 0,
    reason: hits.length > 0 ? "hits_found" : "no_hits",
    topK: params.cfg.memory.topK,
    activeTaskId: "",
    objective,
    hitCount: hits.length,
    skillIds: hits.map((hit) => hit.skill.skillId),
    visibleSkillCount: visibleSkills.length,
    visibleSkillIds: visibleSkills.slice(0, 5).map((skill) => skill.skillId),
    stateDir: params.cfg.stateDir,
  });
  if (hits.length === 0) return { injected: false, hitCount: 0 };

  const rawText = formatProceduralMemoryInjection(hits);
  if (!rawText) return { injected: false, hitCount: 0 };
  const adapted = await adaptProceduralMemoryInjection({
    cfg: params.cfg,
    objective,
    rawInjectionText: rawText,
  });
  await params.helpers.appendTaskStateTrace(params.cfg.stateDir, {
    stage: "procedural_memory_adapted",
    sessionId: params.sessionId,
    objective,
    useful: adapted.useful,
    reason: adapted.reason,
    rawLength: rawText.length,
    adaptedLength: adapted.adaptedHint.length,
    hitCount: hits.length,
    skillIds: hits.map((hit) => hit.skill.skillId),
  });
  if (!adapted.useful || !adapted.adaptedHint) return { injected: false, hitCount: 0 };
  const text = `[TokenPilot Procedural Memory]\n${adapted.adaptedHint}`.trim();

  if (!Array.isArray(params.payload.input)) params.payload.input = [];
  if (params.cfg.memory.injectAsSystemHint) {
    params.payload.input.unshift({
      role: "system",
      content: text,
    });
  } else {
    const userIndex = params.payload.input.findIndex((item: any) => item && typeof item === "object" && String(item.role ?? "") === "user");
    if (userIndex >= 0) {
      const userItem = params.payload.input[userIndex];
      params.payload.input[userIndex] = {
        ...userItem,
        role: "user",
        content: prependTextToContent(userItem?.content, text),
      };
    } else {
      params.payload.input.unshift({
        role: "user",
        content: text,
      });
    }
  }
  await params.helpers.appendTaskStateTrace(params.cfg.stateDir, {
    stage: "procedural_memory_injected",
    sessionId: params.sessionId,
    distillerType: String(params.cfg?.memory?.distillerType ?? "prompting").trim(),
    activeTaskId: "",
    objective,
    hitCount: hits.length,
    skillIds: hits.map((hit) => hit.skill.skillId),
  });
  return { injected: true, hitCount: hits.length };
}
