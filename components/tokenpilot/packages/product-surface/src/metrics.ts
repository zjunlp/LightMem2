import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type RecentReductionMetrics = {
  sampledTurns: number;
  routeSavedChars: Record<string, number>;
  routeHitCount: Record<string, number>;
  passSavedChars: Record<string, number>;
};

type HistoryEntry = {
  sessionId?: string;
  details?: {
    routeSavedChars?: Record<string, number>;
    routeHitCount?: Record<string, number>;
    passSavedChars?: Record<string, number>;
  };
};

function historyPath(stateDir: string): string {
  return join(stateDir, "ux-effects", "history.jsonl");
}

export async function readRecentReductionMetrics(
  stateDir: string,
  sessionId: string,
  limit = 12,
): Promise<RecentReductionMetrics | null> {
  try {
    const raw = await readFile(historyPath(stateDir), "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean).reverse();
    const routeSavedChars: Record<string, number> = {};
    const routeHitCount: Record<string, number> = {};
    const passSavedChars: Record<string, number> = {};
    let sampledTurns = 0;

    for (const line of lines) {
      if (sampledTurns >= limit) break;
      let parsed: HistoryEntry;
      try {
        parsed = JSON.parse(line) as HistoryEntry;
      } catch {
        continue;
      }
      if (parsed.sessionId !== sessionId) continue;
      const details = parsed.details;
      const hasMetrics =
        details?.routeSavedChars ||
        details?.routeHitCount ||
        details?.passSavedChars;
      if (!hasMetrics) continue;
      sampledTurns += 1;
      for (const [key, value] of Object.entries(details?.routeSavedChars ?? {})) {
        routeSavedChars[key] = (routeSavedChars[key] ?? 0) + Number(value || 0);
      }
      for (const [key, value] of Object.entries(details?.routeHitCount ?? {})) {
        routeHitCount[key] = (routeHitCount[key] ?? 0) + Number(value || 0);
      }
      for (const [key, value] of Object.entries(details?.passSavedChars ?? {})) {
        passSavedChars[key] = (passSavedChars[key] ?? 0) + Number(value || 0);
      }
    }

    if (sampledTurns === 0) return null;
    return {
      sampledTurns,
      routeSavedChars,
      routeHitCount,
      passSavedChars,
    };
  } catch {
    return null;
  }
}
