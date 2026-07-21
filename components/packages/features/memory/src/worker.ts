import type { ProceduralMemoryBackend, SkillDistiller } from "./types.js";

export async function runProceduralMemoryBatch(params: {
  backend: ProceduralMemoryBackend;
  batchSize: number;
  distiller: SkillDistiller;
}): Promise<{ drained: number; produced: number; failed: number }> {
  const entries = await params.backend.drainBatch(Math.max(1, params.batchSize));
  if (entries.length === 0) return { drained: 0, produced: 0, failed: 0 };
  try {
    const produced = await params.distiller.distill({
      entries,
    });
    await params.backend.completeBatch(entries, produced);
    return { drained: entries.length, produced: produced.length, failed: 0 };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await params.backend.failBatch(entries, reason);
    return { drained: entries.length, produced: 0, failed: entries.length };
  }
}
