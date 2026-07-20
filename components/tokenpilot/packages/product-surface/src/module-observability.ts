import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  pluginStateSubdirCandidates,
  pluginStateSubdirWriteTargets,
  sanitizePathPart,
} from "@tokenpilot/runtime-core";

export const TOKENPILOT_FEATURE_MODULE_IDS = ["stabilizer", "reduction", "eviction"] as const;
export type TokenPilotFeatureModuleId = (typeof TOKENPILOT_FEATURE_MODULE_IDS)[number];

export type ModuleApiAccounting = {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
};

export type ModuleObservation = {
  at: string;
  sessionId: string;
  phase: "request" | "history";
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
  enabled: boolean;
  executions: number;
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
  const fileName = `${sanitizePathPart(sessionId)}.jsonl`;
  return pluginStateSubdirCandidates(stateDir, "module-observability", fileName);
}

function observationWritePaths(stateDir: string, sessionId: string): string[] {
  const fileName = `${sanitizePathPart(sessionId)}.jsonl`;
  return pluginStateSubdirWriteTargets(stateDir, "module-observability", fileName);
}

export async function appendModuleObservation(
  stateDir: string,
  observation: Omit<ModuleObservation, "at"> & { at?: string },
): Promise<void> {
  const record: ModuleObservation = {
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
  for (const path of observationWritePaths(stateDir, record.sessionId)) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  }
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
            return TOKENPILOT_FEATURE_MODULE_IDS.includes(parsed.moduleId) ? [parsed] : [];
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
    enabled: false,
    executions: 0,
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
  const enabled = TOKENPILOT_FEATURE_MODULE_IDS.filter((moduleId) => modules[moduleId].enabled);
  if (enabled.length === 0) return "none";
  if (enabled.length === TOKENPILOT_FEATURE_MODULE_IDS.length) return "all-enabled";
  return enabled.length === 1 ? `${enabled[0]}-only` : enabled.join("+");
}

export function summarizeModuleObservations(
  sessionId: string,
  observations: ModuleObservation[],
): SessionModuleObservationSummary | null {
  if (observations.length === 0) return null;
  const modules = {
    stabilizer: emptyAggregate(),
    reduction: emptyAggregate(),
    eviction: emptyAggregate(),
  };
  for (const observation of observations) {
    const aggregate = modules[observation.moduleId];
    aggregate.enabled = observation.enabled;
    aggregate.executions += observation.executed ? 1 : 0;
    aggregate.changes += observation.changed ? 1 : 0;
    aggregate.skips += observation.executed ? 0 : 1;
    aggregate.savedChars += Math.max(0, Number(observation.savedChars ?? 0));
    aggregate.savedTokens += Math.max(0, Number(observation.savedTokens ?? 0));
    aggregate.apiInputTokens += Math.max(0, Number(observation.api?.inputTokens ?? 0));
    aggregate.apiOutputTokens += Math.max(0, Number(observation.api?.outputTokens ?? 0));
    if (typeof observation.api?.costUsd === "number") {
      aggregate.apiCostUsd = (aggregate.apiCostUsd ?? 0) + Math.max(0, observation.api.costUsd);
    }
    aggregate.latestAt = observation.at || aggregate.latestAt;
    aggregate.latestSkippedReason = observation.skippedReason;
  }
  const latestAt = observations.reduce(
    (latest, observation) => observation.at > latest ? observation.at : latest,
    "",
  );
  return {
    sessionId,
    mode: moduleMode(modules),
    modules,
    latestAt,
  };
}

export async function readSessionModuleObservationSummary(
  stateDir: string,
  sessionId: string,
): Promise<SessionModuleObservationSummary | null> {
  return summarizeModuleObservations(
    sessionId,
    await readSessionModuleObservations(stateDir, sessionId),
  );
}
