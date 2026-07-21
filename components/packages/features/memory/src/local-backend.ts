import { buildQueueEntry, cosineSimilarity, loadQueueEntries, loadSkills, retrieveRecentSkills, saveQueueEntries, saveSkills } from "./store.js";
import { embedTextsWithOpenAiCompatibleApi } from "./remote-embeddings.js";
import type { DistillProviderConfig, EmbeddingProviderConfig, ProceduralMemoryBackend, ProceduralMemoryQueueEntry, RetrieveSkillsParams, SkillRetrieveHit } from "./types.js";

export function createLocalProceduralMemoryBackend(
  stateDir: string,
  options?: { embeddingProvider?: EmbeddingProviderConfig; distillProvider?: DistillProviderConfig },
): ProceduralMemoryBackend {
  return {
    async enqueue(entries) {
      const current = await loadQueueEntries(stateDir);
      const seen = new Set(current.map((item) => item.queueId));
      let added = 0;
      for (const raw of entries) {
        const next = buildQueueEntry(raw);
        if (seen.has(next.queueId)) continue;
        current.push(next);
        seen.add(next.queueId);
        added += 1;
      }
      if (added > 0) await saveQueueEntries(stateDir, current);
      return added;
    },
    async drainBatch(limit) {
      const current = await loadQueueEntries(stateDir);
      const now = new Date().toISOString();
      const drained: ProceduralMemoryQueueEntry[] = [];
      for (const entry of current) {
        if (entry.status !== "queued") continue;
        entry.status = "inflight";
        entry.updatedAt = now;
        entry.attemptCount += 1;
        drained.push({ ...entry });
        if (drained.length >= limit) break;
      }
      if (drained.length > 0) await saveQueueEntries(stateDir, current);
      return drained;
    },
    async completeBatch(entries, produced) {
      const embeddingProvider = options?.embeddingProvider;
      if (embeddingProvider) {
        const pending = produced.filter((skill) => !Array.isArray(skill.embedding) || skill.embedding.length === 0);
        if (pending.length > 0) {
          const embeddings = await embedTextsWithOpenAiCompatibleApi({
            provider: embeddingProvider,
            inputs: pending.map((skill) => skill.embeddingText),
            isQuery: false,
          });
          for (let index = 0; index < pending.length; index += 1) {
            pending[index]!.embedding = embeddings[index] ?? [];
          }
        }
      }
      const currentQueue = await loadQueueEntries(stateDir);
      const finished = new Set(entries.map((item) => item.queueId));
      const nextQueue = currentQueue.map((entry) =>
        finished.has(entry.queueId)
          ? { ...entry, status: "distilled" as const, updatedAt: new Date().toISOString(), lastError: undefined }
          : entry,
      );
      await saveQueueEntries(stateDir, nextQueue);

      const producedBySession = new Map<string, typeof produced>();
      for (const skill of produced) {
        const bucket = producedBySession.get(skill.sessionId) ?? [];
        bucket.push(skill);
        producedBySession.set(skill.sessionId, bucket);
      }
      for (const [sessionId, sessionSkills] of producedBySession) {
        const currentSkills = await loadSkills(stateDir, sessionId);
        const byId = new Map(currentSkills.map((skill) => [skill.skillId, skill] as const));
        for (const skill of sessionSkills) byId.set(skill.skillId, skill);
        await saveSkills(stateDir, sessionId, [...byId.values()]);
      }
    },
    async failBatch(entries, reason) {
      const currentQueue = await loadQueueEntries(stateDir);
      const failed = new Set(entries.map((item) => item.queueId));
      const now = new Date().toISOString();
      const nextQueue = currentQueue.map((entry) =>
        failed.has(entry.queueId)
          ? { ...entry, status: "failed" as const, updatedAt: now, lastError: reason }
          : entry,
      );
      await saveQueueEntries(stateDir, nextQueue);
    },
    async retrieve(params: RetrieveSkillsParams): Promise<SkillRetrieveHit[]> {
      const embeddingProvider = options?.embeddingProvider;
      if (!embeddingProvider) return retrieveRecentSkills(stateDir, params.sessionId, params.topK);
      const skills = await loadSkills(stateDir, params.sessionId);
      const vectorReady = skills.filter((skill) => Array.isArray(skill.embedding) && skill.embedding.length > 0);
      if (vectorReady.length === 0) return retrieveRecentSkills(stateDir, params.sessionId, params.topK);
      try {
        const [queryEmbedding] = await embedTextsWithOpenAiCompatibleApi({
          provider: embeddingProvider,
          inputs: [params.objective],
          isQuery: true,
        });
        const embeddingHits = vectorReady
          .map((skill) => ({
            skill,
            score: cosineSimilarity(queryEmbedding ?? [], skill.embedding ?? []),
          }))
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score || b.skill.updatedAt.localeCompare(a.skill.updatedAt))
          .slice(0, Math.max(0, params.topK));
        return embeddingHits.length > 0 ? embeddingHits : retrieveRecentSkills(stateDir, params.sessionId, params.topK);
      } catch {
        return retrieveRecentSkills(stateDir, params.sessionId, params.topK);
      }
    },
  };
}
