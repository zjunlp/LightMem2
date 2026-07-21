import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { ensureProceduralMemoryDirs, ensureProceduralMemorySessionDirs, proceduralMemoryQueuePath, proceduralMemoryStorePath } from "./files.js";
import type { ProceduralMemoryQueueEntry, ProceduralSkill, SkillRetrieveHit, RetrieveSkillsParams } from "./types.js";

type QueueFile = {
  entries: ProceduralMemoryQueueEntry[];
};

type StoreFile = {
  skills: ProceduralSkill[];
};

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
}

function scoreSkill(objective: string, skill: ProceduralSkill): number {
  const query = new Set(tokenize(objective));
  if (query.size === 0) return 0;
  const docTokens = tokenize(skill.embeddingText);
  if (docTokens.length === 0) return 0;
  let overlap = 0;
  for (const token of docTokens) {
    if (query.has(token)) overlap += 1;
  }
  const exactBoost = skill.objective.toLowerCase().includes(objective.toLowerCase()) ? 2 : 0;
  return overlap / Math.max(query.size, 1) + exactBoost;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function loadQueueEntries(stateDir: string): Promise<ProceduralMemoryQueueEntry[]> {
  await ensureProceduralMemoryDirs(stateDir);
  const file = await readJsonFile<QueueFile>(proceduralMemoryQueuePath(stateDir), { entries: [] });
  return Array.isArray(file.entries) ? file.entries : [];
}

export async function saveQueueEntries(stateDir: string, entries: ProceduralMemoryQueueEntry[]): Promise<void> {
  await ensureProceduralMemoryDirs(stateDir);
  await writeJsonFile(proceduralMemoryQueuePath(stateDir), { entries });
}

export async function loadSkills(stateDir: string, sessionId: string): Promise<ProceduralSkill[]> {
  await ensureProceduralMemorySessionDirs(stateDir, sessionId);
  const file = await readJsonFile<StoreFile>(proceduralMemoryStorePath(stateDir, sessionId), { skills: [] });
  return Array.isArray(file.skills) ? file.skills : [];
}

export async function saveSkills(stateDir: string, sessionId: string, skills: ProceduralSkill[]): Promise<void> {
  await ensureProceduralMemorySessionDirs(stateDir, sessionId);
  await writeJsonFile(proceduralMemoryStorePath(stateDir, sessionId), { skills });
}

export function makeQueueId(sessionId: string, taskId: string, archivePath: string): string {
  return createHash("sha1").update(`${sessionId}\n${taskId}\n${archivePath}`).digest("hex");
}

export function makeSkillId(taskId: string, guidance: string): string {
  return createHash("sha1").update(`${taskId}\n${guidance}`).digest("hex");
}

export function buildQueueEntry(
  entry: Omit<ProceduralMemoryQueueEntry, "queueId" | "createdAt" | "updatedAt" | "status" | "attemptCount">,
): ProceduralMemoryQueueEntry {
  const now = new Date().toISOString();
  return {
    ...entry,
    queueId: makeQueueId(entry.sessionId, entry.taskId, entry.archivePath),
    createdAt: now,
    updatedAt: now,
    status: "queued",
    attemptCount: 0,
  };
}

export function makeFallbackSkill(sessionId: string, entry: ProceduralMemoryQueueEntry, guidance: {
  title: string;
  guidance: string;
  whenToUse: string[];
  steps: string[];
  facts?: string[];
  pitfalls: string[];
  constraints: string[];
}): ProceduralSkill {
  const now = new Date().toISOString();
  const evidence = [...entry.completionEvidence].filter((item) => item.trim().length > 0);
  const embeddingText = [
    entry.objective,
    guidance.title,
    ...(guidance.facts ?? []),
    guidance.guidance,
    ...guidance.whenToUse,
    ...guidance.pitfalls,
    ...guidance.constraints,
    ...guidance.steps,
  ].join("\n");
  return {
    skillId: makeSkillId(entry.taskId, guidance.guidance),
    sourceTaskId: entry.taskId,
    sessionId,
    title: guidance.title,
    objective: entry.objective,
    guidance: guidance.guidance,
    whenToUse: guidance.whenToUse,
    steps: guidance.steps,
    facts: (guidance.facts ?? []).filter((item) => item.trim().length > 0),
    pitfalls: guidance.pitfalls,
    constraints: guidance.constraints,
    evidence,
    embeddingText,
    createdAt: now,
    updatedAt: now,
  };
}

export async function retrieveRankedSkills(stateDir: string, params: RetrieveSkillsParams): Promise<SkillRetrieveHit[]> {
  const skills = await loadSkills(stateDir, params.sessionId);
  return skills
    .map((skill) => ({ skill, score: scoreSkill(params.objective, skill) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.skill.updatedAt.localeCompare(a.skill.updatedAt))
    .slice(0, Math.max(0, params.topK));
}

export async function retrieveRecentSkills(stateDir: string, sessionId: string, topK: number): Promise<SkillRetrieveHit[]> {
  const skills = await loadSkills(stateDir, sessionId);
  return [...skills]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(0, topK))
    .map((skill, index) => ({
      skill,
      score: Math.max(0, topK - index),
    }));
}
