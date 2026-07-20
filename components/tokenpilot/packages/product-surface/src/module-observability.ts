import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  pluginStateSubdirCandidates,
  pluginStateSubdirWriteTargets,
} from "@tokenpilot/runtime-core";

export const TOKENPILOT_FEATURE_MODULE_IDS = ["stabilizer", "reduction", "eviction"] as const;
export type TokenPilotFeatureModuleId = (typeof TOKENPILOT_FEATURE_MODULE_IDS)[number];
export type ModuleObservationPhase = "request" | "response" | "history";

export type ModuleApiAccounting = {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
};

export type ModuleObservation = {
  at: string;
  sessionId: string;
  phase: ModuleObservationPhase;
  moduleId: TokenPilotFeatureModuleId;
  enabled: boolean;
  executed: boolean;
  changed: boolean;
  skippedReason?: string;
  savedChars: number;
  savedTokens: number;
  api: ModuleApiAccounting;
};

export type ModuleObservationAggregate = {
  observed: boolean;
  enabled: boolean;
  executions: number;
  executionsByPhase?: Record<ModuleObservationPhase, number>;
  phaseBreakdownComplete?: boolean;
  changes: number;
  skips: number;
  savedChars: number;
  savedTokens: number;
  apiInputTokens: number;
  apiOutputTokens: number;
  apiCostUsd?: number;
  latestAt: string;
  latestSkippedReason?: string;
};

export type SessionModuleObservationSummary = {
  sessionId: string;
  mode: string;
  modules: Record<TokenPilotFeatureModuleId, ModuleObservationAggregate>;
  latestAt: string;
};

function observationPaths(stateDir: string, sessionId: string): string[] {
  const fileName = `${encodeURIComponent(sessionId)}.jsonl`;
  return [
    ...pluginStateSubdirCandidates(stateDir, "module-observability", "events", fileName),
    ...pluginStateSubdirCandidates(stateDir, "module-observability", `${sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_")}.jsonl`),
  ];
}

function observationWritePaths(stateDir: string, sessionId: string): string[] {
  const fileName = `${encodeURIComponent(sessionId)}.jsonl`;
  return pluginStateSubdirWriteTargets(stateDir, "module-observability", "events", fileName);
}

function summaryPaths(stateDir: string, sessionId: string): string[] {
  const fileName = `${encodeURIComponent(sessionId)}.json`;
  return pluginStateSubdirCandidates(stateDir, "module-observability", "sessions", fileName);
}

function summaryWritePaths(stateDir: string, sessionId: string): string[] {
  const fileName = `${encodeURIComponent(sessionId)}.json`;
  return pluginStateSubdirWriteTargets(stateDir, "module-observability", "sessions", fileName);
}

function summaryDirPaths(stateDir: string): string[] {
  return pluginStateSubdirCandidates(stateDir, "module-observability", "sessions");
}

function legacyObservationDirPaths(stateDir: string): string[] {
  return pluginStateSubdirCandidates(stateDir, "module-observability");
}

async function writeJsonAtomic(path: string, payload: unknown): Promise<void> {
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

const writeQueues = new Map<string, Promise<void>>();

function enqueueSessionWrite(key: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(write);
  writeQueues.set(key, current);
  return current.finally(() => {
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  });
}

function normalizeObservation(
  observation: Omit<ModuleObservation, "at"> & { at?: string },
): ModuleObservation {
  return {
    ...observation,
    at: observation.at ?? new Date().toISOString(),
    savedChars: Math.max(0, Number(observation.savedChars ?? 0)),
    savedTokens: Math.max(0, Number(observation.savedTokens ?? 0)),
    api: {
      inputTokens: Math.max(0, Number(observation.api?.inputTokens ?? 0)),
      outputTokens: Math.max(0, Number(observation.api?.outputTokens ?? 0)),
      ...(typeof observation.api?.costUsd === "number"
        ? { costUsd: Math.max(0, observation.api.costUsd) }
        : {}),
    },
  };
}

export async function appendModuleObservations(
  stateDir: string,
  observations: Array<Omit<ModuleObservation, "at"> & { at?: string }>,
): Promise<void> {
  if (observations.length === 0) return;
  const records = observations.map(normalizeObservation);
  const sessionId = records[0].sessionId;
  if (records.some((record) => record.sessionId !== sessionId)) {
    throw new Error("module observations must belong to one session");
  }
  const queueKey = `${stateDir}\0${sessionId}`;
  await enqueueSessionWrite(queueKey, async () => {
    const current = await readSessionModuleObservationSummary(stateDir, sessionId);
    const next = applyObservationsToSummary(
      current ?? createEmptySummary(sessionId),
      records,
    );
    for (const path of summaryWritePaths(stateDir, sessionId)) {
      await writeJsonAtomic(path, next);
    }
    for (const path of observationWritePaths(stateDir, sessionId)) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
      } catch {
        // The bounded session summary is authoritative; JSONL is best-effort audit history.
      }
    }
  });
}

export async function appendModuleObservation(
  stateDir: string,
  observation: Omit<ModuleObservation, "at"> & { at?: string },
): Promise<void> {
  await appendModuleObservations(stateDir, [observation]);
}

export async function readSessionModuleObservations(
  stateDir: string,
  sessionId: string,
): Promise<ModuleObservation[]> {
  for (const path of observationPaths(stateDir, sessionId)) {
    try {
      const raw = await readFile(path, "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as ModuleObservation;
            return TOKENPILOT_FEATURE_MODULE_IDS.includes(parsed.moduleId)
              && parsed.sessionId === sessionId
              ? [parsed]
              : [];
          } catch {
            return [];
          }
        });
    } catch {
      // Try the next compatible state root.
    }
  }
  return [];
}

function emptyAggregate(): ModuleObservationAggregate {
  return {
    observed: false,
    enabled: false,
    executions: 0,
    executionsByPhase: { request: 0, response: 0, history: 0 },
    phaseBreakdownComplete: true,
    changes: 0,
    skips: 0,
    savedChars: 0,
    savedTokens: 0,
    apiInputTokens: 0,
    apiOutputTokens: 0,
    latestAt: "",
  };
}

function moduleMode(modules: Record<TokenPilotFeatureModuleId, ModuleObservationAggregate>): string {
  const observed = TOKENPILOT_FEATURE_MODULE_IDS.filter((moduleId) => modules[moduleId].observed);
  if (observed.length === 0) return "unknown";
  if (observed.length < TOKENPILOT_FEATURE_MODULE_IDS.length) return "partial";
  const enabled = observed.filter((moduleId) => modules[moduleId].enabled);
  if (enabled.length === 0) return "none";
  if (
    observed.length === TOKENPILOT_FEATURE_MODULE_IDS.length
    && enabled.length === TOKENPILOT_FEATURE_MODULE_IDS.length
  ) return "all-enabled";
  return enabled.length === 1 ? `${enabled[0]}-only` : enabled.join("+");
}

function createEmptySummary(sessionId: string): SessionModuleObservationSummary {
  return {
    sessionId,
    mode: "unknown",
    modules: {
      stabilizer: emptyAggregate(),
      reduction: emptyAggregate(),
      eviction: emptyAggregate(),
    },
    latestAt: "",
  };
}

function applyObservationsToSummary(
  summary: SessionModuleObservationSummary,
  observations: ModuleObservation[],
): SessionModuleObservationSummary {
  const next = structuredClone(summary);
  for (const observation of observations) {
    const aggregate = next.modules[observation.moduleId];
    aggregate.observed = true;
    if (!aggregate.executionsByPhase) {
      aggregate.executionsByPhase = { request: 0, response: 0, history: 0 };
      aggregate.phaseBreakdownComplete = aggregate.executions === 0;
    }
    aggregate.executions += observation.executed ? 1 : 0;
    aggregate.executionsByPhase[observation.phase] += observation.executed ? 1 : 0;
    const appliedChange = observation.moduleId === "eviction"
      ? observation.phase === "history" && observation.changed
      : observation.changed;
    aggregate.changes += appliedChange ? 1 : 0;
    aggregate.skips += observation.skippedReason && observation.skippedReason !== "none" ? 1 : 0;
    aggregate.savedChars += Math.max(0, Number(observation.savedChars ?? 0));
    aggregate.savedTokens += Math.max(0, Number(observation.savedTokens ?? 0));
    aggregate.apiInputTokens += Math.max(0, Number(observation.api?.inputTokens ?? 0));
    aggregate.apiOutputTokens += Math.max(0, Number(observation.api?.outputTokens ?? 0));
    if (typeof observation.api?.costUsd === "number") {
      aggregate.apiCostUsd = (aggregate.apiCostUsd ?? 0) + Math.max(0, observation.api.costUsd);
    }
    if (observation.phase !== "response" && (!aggregate.latestAt || observation.at >= aggregate.latestAt)) {
      aggregate.enabled = observation.enabled;
      aggregate.latestAt = observation.at;
      aggregate.latestSkippedReason = observation.skippedReason;
    }
    if (observation.at > next.latestAt) next.latestAt = observation.at;
  }
  next.mode = moduleMode(next.modules);
  return next;
}

export function summarizeModuleObservations(
  sessionId: string,
  observations: ModuleObservation[],
): SessionModuleObservationSummary | null {
  if (observations.length === 0) return null;
  return applyObservationsToSummary(createEmptySummary(sessionId), observations);
}

export async function readSessionModuleObservationSummary(
  stateDir: string,
  sessionId: string,
): Promise<SessionModuleObservationSummary | null> {
  for (const path of summaryPaths(stateDir, sessionId)) {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as SessionModuleObservationSummary;
      if (parsed?.sessionId === sessionId && parsed.modules) return parsed;
    } catch {
      // Try the next compatible state root.
    }
  }
  return summarizeModuleObservations(sessionId, await readSessionModuleObservations(stateDir, sessionId));
}

export async function listSessionModuleObservationSummaries(
  stateDir: string,
): Promise<SessionModuleObservationSummary[]> {
  const summariesBySession = new Map<string, SessionModuleObservationSummary>();
  for (const dir of summaryDirPaths(stateDir)) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const summaries = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            return JSON.parse(await readFile(join(dir, entry.name), "utf8")) as SessionModuleObservationSummary;
          } catch {
            return null;
          }
        }));
      for (const summary of summaries) {
        if (summary?.sessionId) summariesBySession.set(summary.sessionId, summary);
      }
      break;
    } catch {
      // Try the next compatible state root.
    }
  }
  for (const dir of legacyObservationDirPaths(stateDir)) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        try {
          const observations = (await readFile(join(dir, entry.name), "utf8"))
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .flatMap((line) => {
              try {
                return [JSON.parse(line) as ModuleObservation];
              } catch {
                return [];
              }
            });
          const observationsBySession = new Map<string, ModuleObservation[]>();
          for (const observation of observations) {
            const sessionId = String(observation.sessionId ?? "").trim();
            if (!sessionId || summariesBySession.has(sessionId)) continue;
            const sessionObservations = observationsBySession.get(sessionId) ?? [];
            sessionObservations.push(observation);
            observationsBySession.set(sessionId, sessionObservations);
          }
          for (const [sessionId, sessionObservations] of observationsBySession) {
            const summary = summarizeModuleObservations(sessionId, sessionObservations);
            if (summary) summariesBySession.set(sessionId, summary);
          }
        } catch {
          // Ignore malformed legacy files.
        }
      }
      break;
    } catch {
      // Try the next compatible state root.
    }
  }
  return [...summariesBySession.values()];
}
