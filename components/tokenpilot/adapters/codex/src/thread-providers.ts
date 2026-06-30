import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const TOKENPILOT_PROVIDER = "tokenpilot";

function candidateDbPaths(codexHome: string): string[] {
  return [
    join(codexHome, "state_5.sqlite"),
    join(codexHome, "sqlite", "state_5.sqlite"),
  ];
}

function retagOne(path: string, fromProvider: string, toProvider: string): number {
  const db = new DatabaseSync(path);
  try {
    const hasThreads = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
    ).get();
    if (!hasThreads) return 0;
    const result = db.prepare(
      "UPDATE threads SET model_provider = ? WHERE model_provider = ?",
    ).run(toProvider, fromProvider);
    return Number(result.changes ?? 0);
  } finally {
    db.close();
  }
}

export function migrateCodexThreadProviders(params: {
  codexHome: string;
  activeProviderName: string;
}): {
  migrated: boolean;
  movedRows: number;
  touchedDbs: number;
} {
  const activeProviderName = params.activeProviderName.trim();
  if (!activeProviderName || activeProviderName === TOKENPILOT_PROVIDER) {
    return {
      migrated: false,
      movedRows: 0,
      touchedDbs: 0,
    };
  }

  let movedRows = 0;
  let touchedDbs = 0;
  for (const path of candidateDbPaths(params.codexHome)) {
    if (!existsSync(path)) continue;
    try {
      const moved = retagOne(path, TOKENPILOT_PROVIDER, activeProviderName);
      touchedDbs += 1;
      movedRows += moved;
    } catch {
      // Best-effort only: install should not fail because Codex has a locked or incompatible store.
    }
  }

  return {
    migrated: touchedDbs > 0,
    movedRows,
    touchedDbs,
  };
}
