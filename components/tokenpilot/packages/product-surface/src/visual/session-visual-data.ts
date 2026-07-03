import { readdir, readFile, mkdir, appendFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readRecentReductionMetrics, summarizeRecentReductionMetrics, type RecentReductionMetricsSummary } from "../metrics.js";

async function appendJsonl(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const normalized = `${JSON.stringify(payload)}\n`;
  await appendFile(path, normalized, "utf8");
}

export type ReductionVisualSnapshot = {
  kind: "reduction";
  at: string;
  sessionId: string;
  requestId: string;
  model: string;
  upstreamModel: string;
  segmentId: string;
  itemIndex: number;
  field: "content" | "arguments" | "output" | "result";
  blockIndex?: number;
  blockKey?: "text" | "content";
  toolName?: string;
  dataPath?: string;
  savedChars: number;
  route?: string;
  routeReason?: string;
  passSavedChars?: Record<string, number>;
  beforeText: string;
  afterText: string;
  report: Array<{
    id: string;
    phase: string;
    target: string;
    changed: boolean;
    note?: string;
    skippedReason?: string;
    beforeChars?: number;
    afterChars?: number;
    touchedSegmentIds?: string[];
  }>;
};

export type VisualUxAggregate = {
  turns?: number;
  latestCountMode?: string;
  tokenOptimizedTurns?: number;
  tokenSavedCount?: number;
  avgSavedTokensPerOptimizedTurn?: number;
  charOptimizedTurns?: number;
  charSavedCount?: number;
  avgSavedCharsPerOptimizedTurn?: number;
  passSavedChars?: Record<string, number>;
  routeSavedChars?: Record<string, number>;
  routeHitCount?: Record<string, number>;
  latestAt?: string;
};

export type StabilityVisualSnapshot = {
  kind: "stability";
  at: string;
  sessionId: string;
  model: string;
  upstreamModel: string;
  promptCacheKeyBefore: string;
  promptCacheKeyAfter: string;
  dynamicContextTarget: "developer" | "user";
  userContentRewrites: number;
  senderMetadataBlocksBefore: number;
  senderMetadataBlocksAfter: number;
  developerBefore: string;
  developerCanonical: string;
  developerForwarded: string;
  dynamicContextText?: string;
  firstTurnCandidate: boolean;
};

export type EvictionVisualSnapshot = {
  kind: "eviction";
  at: string;
  sessionId: string;
  taskId: string;
  taskLabel?: string;
  replacementMode: "pointer_stub" | "drop";
  beforeText: string;
  afterText: string;
  beforeChars: number;
  afterChars: number;
  archivePath: string;
  dataKey: string;
  turnAbsIds: string[];
};

export type VisualSessionSummary = {
  sessionId: string;
  stabilityCount: number;
  reductionCount: number;
  evictionCount: number;
  lastAt: string;
};

export type VisualSessionData = {
  sessionId: string;
  stability: StabilityVisualSnapshot[];
  reduction: ReductionVisualSnapshot[];
  eviction: EvictionVisualSnapshot[];
  uxAggregate?: VisualUxAggregate | null;
  recentReduction?: RecentReductionMetricsSummary | null;
};

function encodeSessionId(sessionId: string): string {
  return encodeURIComponent(String(sessionId || "").trim() || "session");
}

function pluginStateSubdirCandidates(stateDir: string, ...parts: string[]): string[] {
  return [join(stateDir.trim(), "tokenpilot", ...parts)];
}

function pluginStateSubdirWriteTargets(stateDir: string, ...parts: string[]): string[] {
  return [join(stateDir.trim(), "tokenpilot", ...parts)];
}

function snapshotWriteTargets(stateDir: string, kind: "stability" | "reduction" | "eviction", sessionId: string): string[] {
  return pluginStateSubdirWriteTargets(stateDir, "visual", kind, `${encodeSessionId(sessionId)}.jsonl`);
}

function snapshotCandidates(stateDir: string, kind: "stability" | "reduction" | "eviction", sessionId: string): string[] {
  return pluginStateSubdirCandidates(stateDir, "visual", kind, `${encodeSessionId(sessionId)}.jsonl`);
}

function snapshotDirCandidates(stateDir: string, kind: "stability" | "reduction" | "eviction"): string[] {
  return pluginStateSubdirCandidates(stateDir, "visual", kind);
}

function parseJsonlLines<T>(raw: string): T[] {
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Ignore malformed historical lines.
    }
  }
  return out;
}

function sortByAtDesc<T extends { at: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => String(right.at).localeCompare(String(left.at)));
}

function latestAtOf<T extends { at: string }>(items: T[]): string {
  return items.reduce((latest, item) => item.at > latest ? item.at : latest, "");
}

async function readSnapshotFile<T>(paths: string[]): Promise<T[]> {
  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf8");
      return parseJsonlLines<T>(raw);
    } catch {
      // try next candidate
    }
  }
  return [];
}

async function readJsonFile<T>(paths: string[]): Promise<T | null> {
  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function uxAggregateCandidates(stateDir: string, sessionId: string): string[] {
  return pluginStateSubdirCandidates(stateDir, "ux-effects", "sessions", `${sessionId}.json`);
}

async function listSnapshotFiles(stateDir: string, kind: "stability" | "reduction" | "eviction"): Promise<string[]> {
  for (const dir of snapshotDirCandidates(stateDir, kind)) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name)
        .sort();
    } catch {
      // try next candidate
    }
  }
  return [];
}

export async function appendReductionVisualSnapshot(stateDir: string, snapshot: ReductionVisualSnapshot): Promise<void> {
  if (!snapshot.sessionId || snapshot.savedChars <= 0) return;
  for (const path of snapshotWriteTargets(stateDir, "reduction", snapshot.sessionId)) {
    await appendJsonl(path, snapshot);
  }
}

export async function appendStabilityVisualSnapshot(stateDir: string, snapshot: StabilityVisualSnapshot): Promise<void> {
  if (!snapshot.sessionId) return;
  for (const path of snapshotWriteTargets(stateDir, "stability", snapshot.sessionId)) {
    await appendJsonl(path, snapshot);
  }
}

export async function appendEvictionVisualSnapshot(stateDir: string, snapshot: EvictionVisualSnapshot): Promise<void> {
  if (!snapshot.sessionId || !snapshot.taskId) return;
  for (const path of snapshotWriteTargets(stateDir, "eviction", snapshot.sessionId)) {
    await appendJsonl(path, snapshot);
  }
}

export async function readVisualSessionData(stateDir: string, sessionId: string): Promise<VisualSessionData> {
  const stability = sortByAtDesc(await readSnapshotFile<StabilityVisualSnapshot>(snapshotCandidates(stateDir, "stability", sessionId)));
  const reduction = sortByAtDesc(await readSnapshotFile<ReductionVisualSnapshot>(snapshotCandidates(stateDir, "reduction", sessionId)));
  const eviction = sortByAtDesc(await readSnapshotFile<EvictionVisualSnapshot>(snapshotCandidates(stateDir, "eviction", sessionId)));
  const [uxAggregate, recentMetrics] = await Promise.all([
    readJsonFile<VisualUxAggregate>(uxAggregateCandidates(stateDir, sessionId)),
    readRecentReductionMetrics(stateDir, sessionId),
  ]);
  return {
    sessionId,
    stability,
    reduction,
    eviction,
    uxAggregate,
    recentReduction: recentMetrics ? summarizeRecentReductionMetrics(recentMetrics) : null,
  };
}

export async function readVisualSessionList(stateDir: string): Promise<VisualSessionSummary[]> {
  const stabilityFiles = await listSnapshotFiles(stateDir, "stability");
  const reductionFiles = await listSnapshotFiles(stateDir, "reduction");
  const evictionFiles = await listSnapshotFiles(stateDir, "eviction");
  const summaryBySessionId = new Map<string, VisualSessionSummary>();

  const mergeCount = async (kind: "stability" | "reduction" | "eviction", fileName: string) => {
    const sessionId = decodeURIComponent(basename(fileName, ".jsonl"));
    const summary = summaryBySessionId.get(sessionId) ?? {
      sessionId,
      stabilityCount: 0,
      reductionCount: 0,
      evictionCount: 0,
      lastAt: "",
    };
    if (kind === "stability") {
      const snapshots = await readSnapshotFile<StabilityVisualSnapshot>(snapshotCandidates(stateDir, "stability", sessionId));
      if (snapshots.length === 0) return;
      summary.stabilityCount = snapshots.length;
      const latestAt = latestAtOf(snapshots);
      if (latestAt > summary.lastAt) summary.lastAt = latestAt;
    } else if (kind === "reduction") {
      const snapshots = await readSnapshotFile<ReductionVisualSnapshot>(snapshotCandidates(stateDir, "reduction", sessionId));
      if (snapshots.length === 0) return;
      summary.reductionCount = snapshots.length;
      const latestAt = latestAtOf(snapshots);
      if (latestAt > summary.lastAt) summary.lastAt = latestAt;
    } else {
      const snapshots = await readSnapshotFile<EvictionVisualSnapshot>(snapshotCandidates(stateDir, "eviction", sessionId));
      if (snapshots.length === 0) return;
      summary.evictionCount = snapshots.length;
      const latestAt = latestAtOf(snapshots);
      if (latestAt > summary.lastAt) summary.lastAt = latestAt;
    }
    summaryBySessionId.set(sessionId, summary);
  };

  for (const fileName of stabilityFiles) {
    await mergeCount("stability", fileName);
  }
  for (const fileName of reductionFiles) {
    await mergeCount("reduction", fileName);
  }
  for (const fileName of evictionFiles) {
    await mergeCount("eviction", fileName);
  }

  return [...summaryBySessionId.values()].sort((left, right) => right.lastAt.localeCompare(left.lastAt));
}
