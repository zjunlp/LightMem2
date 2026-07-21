import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  TOKENPILOT_MODULE_COMBINATIONS,
  buildTokenPilotCombinationConfig,
  type TokenPilotFeatureModule,
  type TokenPilotModuleCombination,
  type TokenPilotModuleEnablement,
} from "@lightmem2/tokenpilot";

export type { TokenPilotFeatureModule };
export type ModuleEnablement = TokenPilotModuleEnablement;
export type ModuleCombination = TokenPilotModuleCombination;
export const MODULE_COMBINATIONS = TOKENPILOT_MODULE_COMBINATIONS;

export function buildModuleCombinationConfig(enablement: ModuleEnablement) {
  return buildTokenPilotCombinationConfig(enablement);
}

export type PayloadDiffEntry = {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function appendPath(parent: string, key: string): string {
  if (!parent) return key;
  return /^\d+$/.test(key) ? `${parent}[${key}]` : `${parent}.${key}`;
}

export function diffPayload(before: unknown, after: unknown, path = ""): PayloadDiffEntry[] {
  if (Object.is(before, after)) return [];

  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: PayloadDiffEntry[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const itemPath = appendPath(path, String(index));
      if (index >= before.length) {
        changes.push({ path: itemPath, kind: "added", after: after[index] });
      } else if (index >= after.length) {
        changes.push({ path: itemPath, kind: "removed", before: before[index] });
      } else {
        changes.push(...diffPayload(before[index], after[index], itemPath));
      }
    }
    return changes;
  }

  if (isRecord(before) && isRecord(after)) {
    const changes: PayloadDiffEntry[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const itemPath = appendPath(path, key);
      if (!(key in before)) {
        changes.push({ path: itemPath, kind: "added", after: after[key] });
      } else if (!(key in after)) {
        changes.push({ path: itemPath, kind: "removed", before: before[key] });
      } else {
        changes.push(...diffPayload(before[key], after[key], itemPath));
      }
    }
    return changes;
  }

  return [{ path: path || "$", kind: "changed", before, after }];
}

export type StateFileSnapshot = {
  bytes: number;
  sha256: string;
  text?: string;
};

export type StateDirectorySnapshot = Record<string, StateFileSnapshot>;

export type StateFileDiff = {
  path: string;
  kind: "created" | "modified" | "deleted";
  before?: StateFileSnapshot;
  after?: StateFileSnapshot;
};

async function listFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(rootDir, entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function snapshotStateDirectory(stateDir: string): Promise<StateDirectorySnapshot> {
  const snapshot: StateDirectorySnapshot = {};
  for (const filePath of await listFiles(stateDir)) {
    const contents = await readFile(filePath);
    const relativePath = relative(stateDir, filePath).split("\\").join("/");
    const isText = !contents.includes(0);
    snapshot[relativePath] = {
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
      ...(isText ? { text: contents.toString("utf8") } : {}),
    };
  }
  return snapshot;
}

export function diffStateDirectories(
  before: StateDirectorySnapshot,
  after: StateDirectorySnapshot,
): StateFileDiff[] {
  const changes: StateFileDiff[] = [];
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const path of [...paths].sort()) {
    if (!(path in before)) {
      changes.push({ path, kind: "created", after: after[path] });
    } else if (!(path in after)) {
      changes.push({ path, kind: "deleted", before: before[path] });
    } else if (before[path].sha256 !== after[path].sha256) {
      changes.push({ path, kind: "modified", before: before[path], after: after[path] });
    }
  }
  return changes;
}

export type ModuleAccounting = {
  savedTokens: number;
  costTokens: number;
  costUsd: number;
};

export type RecordedModuleEffects = {
  stateWrites: Array<{ path: string; value: unknown }>;
  traces: Array<{ name: string; payload: unknown }>;
  events: Array<{ name: string; payload: unknown }>;
  visualSnapshots: Array<{ name: string; payload: unknown }>;
  accounting: ModuleAccounting;
};

function createEmptyEffects(): RecordedModuleEffects {
  return {
    stateWrites: [],
    traces: [],
    events: [],
    visualSnapshots: [],
    accounting: {
      savedTokens: 0,
      costTokens: 0,
      costUsd: 0,
    },
  };
}

export function createModuleEffectRecorder() {
  const effects: Record<TokenPilotFeatureModule, RecordedModuleEffects> = {
    stabilizer: createEmptyEffects(),
    reduction: createEmptyEffects(),
    eviction: createEmptyEffects(),
  };

  return {
    recordStateWrite(module: TokenPilotFeatureModule, path: string, value: unknown) {
      effects[module].stateWrites.push({ path, value });
    },
    recordTrace(module: TokenPilotFeatureModule, name: string, payload: unknown) {
      effects[module].traces.push({ name, payload });
    },
    recordEvent(module: TokenPilotFeatureModule, name: string, payload: unknown) {
      effects[module].events.push({ name, payload });
    },
    recordVisualSnapshot(module: TokenPilotFeatureModule, name: string, payload: unknown) {
      effects[module].visualSnapshots.push({ name, payload });
    },
    recordAccounting(module: TokenPilotFeatureModule, delta: Partial<ModuleAccounting>) {
      effects[module].accounting.savedTokens += delta.savedTokens ?? 0;
      effects[module].accounting.costTokens += delta.costTokens ?? 0;
      effects[module].accounting.costUsd += delta.costUsd ?? 0;
    },
    snapshot(): Record<TokenPilotFeatureModule, RecordedModuleEffects> {
      return structuredClone(effects);
    },
  };
}
