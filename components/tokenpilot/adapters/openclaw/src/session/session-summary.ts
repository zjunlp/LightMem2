import { dirname, join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { pluginStateSubdirCandidates, pluginStateSubdirWriteTargets } from "@tokenpilot/artifact-store";

export type OpenClawSessionSummary = {
  sessionId: string;
  sessionKey?: string;
  workspaceHint?: string;
  latestModel?: string;
  turnCount?: number;
  requestChars?: number;
  responseChars?: number;
  assistantChars?: number;
  reductionSavedChars?: number;
  updatedAt: string;
};

function summaryPathCandidates(stateDir: string, sessionId: string): string[] {
  return pluginStateSubdirCandidates(stateDir, "session-state", "sessions", `${sessionId}.json`);
}

function summaryWriteTargets(stateDir: string, sessionId: string): string[] {
  return pluginStateSubdirWriteTargets(stateDir, "session-state", "sessions", `${sessionId}.json`);
}

async function writeJsonFileAtomic(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function normalizeText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function normalizeCount(value: unknown): number | undefined {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : undefined;
}

export async function readOpenClawSessionSummary(
  stateDir: string,
  sessionId: string,
): Promise<OpenClawSessionSummary | null> {
  for (const path of summaryPathCandidates(stateDir, sessionId)) {
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as OpenClawSessionSummary;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function upsertOpenClawSessionSummary(
  stateDir: string,
  sessionId: string,
  patch: Partial<OpenClawSessionSummary>,
): Promise<OpenClawSessionSummary> {
  const current = await readOpenClawSessionSummary(stateDir, sessionId);
  const next: OpenClawSessionSummary = {
    sessionId,
    sessionKey: normalizeText(patch.sessionKey) ?? current?.sessionKey,
    workspaceHint: normalizeText(patch.workspaceHint) ?? current?.workspaceHint,
    latestModel: normalizeText(patch.latestModel) ?? current?.latestModel,
    turnCount: normalizeCount(patch.turnCount) ?? current?.turnCount,
    requestChars: normalizeCount(patch.requestChars) ?? current?.requestChars,
    responseChars: normalizeCount(patch.responseChars) ?? current?.responseChars,
    assistantChars: normalizeCount(patch.assistantChars) ?? current?.assistantChars,
    reductionSavedChars: normalizeCount(patch.reductionSavedChars) ?? current?.reductionSavedChars,
    updatedAt: normalizeText(patch.updatedAt) ?? current?.updatedAt ?? new Date().toISOString(),
  };

  for (const path of summaryWriteTargets(stateDir, sessionId)) {
    await writeJsonFileAtomic(path, next);
  }
  return next;
}

export function buildOpenClawSessionOverview(
  sessionId: string,
  summary: OpenClawSessionSummary | null,
): Array<{ label: string; value: string | number }> {
  const overview: Array<{ label: string; value: string | number }> = [
    { label: "Session", value: sessionId },
    { label: "Turns", value: summary?.turnCount ?? 0 },
    { label: "Model", value: summary?.latestModel ?? "unknown" },
    { label: "Workspace", value: summary?.workspaceHint ?? "unknown" },
  ];

  if (summary?.sessionKey) {
    overview.push({ label: "Session key", value: summary.sessionKey });
  }
  if (summary?.requestChars !== undefined) {
    overview.push({ label: "Latest request chars", value: summary.requestChars });
  }
  if (summary?.responseChars !== undefined) {
    overview.push({ label: "Latest response chars", value: summary.responseChars });
  }
  if (summary?.assistantChars !== undefined) {
    overview.push({ label: "Latest assistant chars", value: summary.assistantChars });
  }
  if (summary?.reductionSavedChars !== undefined) {
    overview.push({ label: "Latest reduction savings", value: summary.reductionSavedChars });
  }

  return overview;
}
