import { readdir, readFile, mkdir, appendFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  readRecentCacheAuditRecordsForSession,
  summarizeCacheAudit,
  type CacheAuditRecord,
  type CacheAuditSummary,
} from "@tokenpilot/host-adapter";
import { diagnoseCacheAudit, type CacheAuditDiagnosis } from "@tokenpilot/stabilizer";
import { readRecentReductionMetrics, summarizeRecentReductionMetrics, type RecentReductionMetricsSummary } from "../metrics.js";
import {
  listSessionModuleObservationSummaries,
  readSessionModuleObservationSummary,
  type SessionModuleObservationSummary,
} from "../module-observability.js";

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
  latestCountMode?: string;
  tokenOptimizedTurns?: number;
  tokenSavedCount?: number;
  charOptimizedTurns?: number;
  charSavedCount?: number;
  cacheAuditSummary?: CacheAuditSummary | null;
};

export type VisualSessionData = {
  sessionId: string;
  stability: StabilityVisualSnapshot[];
  reduction: ReductionVisualSnapshot[];
  reductionCalls?: VisualReductionCallGroup[];
  eviction: EvictionVisualSnapshot[];
  uxAggregate?: VisualUxAggregate | null;
  recentReduction?: RecentReductionMetricsSummary | null;
  cacheAuditSummary?: CacheAuditSummary | null;
  cacheAuditWindow?: VisualCacheAuditEntry[];
  recentCacheAudit?: VisualCacheAuditEntry[];
  recentCacheAuditGroups?: VisualCacheAuditGroup[];
  moduleSummary?: SessionModuleObservationSummary | null;
  limits?: {
    stabilityTotal: number;
    stabilityReturned: number;
    reductionTotal: number;
    reductionReturned: number;
    reductionCallTotal: number;
    reductionCallReturned: number;
    evictionTotal: number;
    evictionReturned: number;
  };
};

export type VisualSessionListResult = {
  sessions: VisualSessionSummary[];
  total: number;
  offset: number;
  limit: number;
  totals: {
    stabilityCount: number;
    reductionCount: number;
    evictionCount: number;
    latestAt: string;
  };
};

export type VisualReductionCallGroup = {
  requestId: string;
  at: string;
  model: string;
  upstreamModel: string;
  totalSavedChars: number;
  segmentCount: number;
  toolNames: string[];
  routes: string[];
  dataPaths: string[];
  segments: ReductionVisualSnapshot[];
};

export type VisualCacheAuditEntry = {
  at: string;
  model: string;
  stream: boolean;
  stablePrefixFingerprint: string;
  originalRequestPromptCacheKey: string | null;
  requestPromptCacheKey: string | null;
  responsePromptCacheKey: string | null;
  cachedInputTokens: number;
  status: number;
  baselineKind: "identity" | "request_key" | "session" | "none";
  entropyKinds: string[];
  driftKeys: string[];
  entropyFindings: Array<{
    kind: string;
    segmentKey: string;
    layer: string;
    detail: string;
  }>;
  driftReasons: Array<{
    kind: string;
    key: string;
    detail: string;
  }>;
  diagnosis: CacheAuditDiagnosis;
};

export type VisualCacheAuditGroup = {
  stablePrefixFingerprint: string;
  latestAt: string;
  latestModel: string;
  requestCount: number;
  warmHitCount: number;
  rewriteCount: number;
  originalRequestPromptCacheKeys: string[];
  requestPromptCacheKeys: string[];
  responsePromptCacheKeys: string[];
  entropyKinds: string[];
  driftKeys: string[];
};

function toVisualCacheAuditEntry(record: CacheAuditRecord): VisualCacheAuditEntry {
  return {
    at: record.at,
    model: record.model,
    stream: record.stream,
    stablePrefixFingerprint: record.stablePrefixFingerprint,
    originalRequestPromptCacheKey: record.originalRequestPromptCacheKey ?? null,
    requestPromptCacheKey: record.requestPromptCacheKey,
    responsePromptCacheKey: record.responsePromptCacheKey,
    cachedInputTokens: Number(record.cachedInputTokens ?? 0),
    status: Number(record.status ?? 0),
    baselineKind: record.baselineKind ?? "none",
    entropyKinds: Array.isArray(record.entropyFindings)
      ? record.entropyFindings.map((entry) => String(entry.kind || "")).filter(Boolean)
      : [],
    driftKeys: Array.isArray(record.driftReasons)
      ? record.driftReasons.map((entry) => String(entry.key || "")).filter(Boolean)
      : [],
    entropyFindings: Array.isArray(record.entropyFindings)
      ? record.entropyFindings.map((entry) => ({
        kind: String(entry.kind || ""),
        segmentKey: String(entry.segmentKey || ""),
        layer: String(entry.layer || ""),
        detail: String(entry.detail || ""),
      }))
      : [],
    driftReasons: Array.isArray(record.driftReasons)
      ? record.driftReasons.map((entry) => ({
        kind: String(entry.kind || ""),
        key: String(entry.key || ""),
        detail: String(entry.detail || ""),
      }))
      : [],
    diagnosis: diagnoseCacheAudit({
      stablePrefixFingerprint: record.stablePrefixFingerprint,
      requestPromptCacheKey: record.requestPromptCacheKey,
      responsePromptCacheKey: record.responsePromptCacheKey,
      cachedInputTokens: Number(record.cachedInputTokens ?? 0),
      baselineKind: record.baselineKind ?? "none",
      entropyFindings: Array.isArray(record.entropyFindings) ? record.entropyFindings : [],
      driftReasons: Array.isArray(record.driftReasons) ? record.driftReasons : [],
    }),
  };
}

function stableUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function reductionSnapshotIdentity(snapshot: ReductionVisualSnapshot): string {
  return JSON.stringify([
    snapshot.requestId,
    snapshot.segmentId,
    snapshot.itemIndex,
    snapshot.field,
    snapshot.blockIndex ?? null,
    snapshot.blockKey ?? null,
    snapshot.toolName ?? null,
    snapshot.dataPath ?? null,
    snapshot.savedChars,
    snapshot.route ?? null,
    snapshot.routeReason ?? null,
    snapshot.beforeText,
    snapshot.afterText,
    snapshot.passSavedChars ?? null,
    snapshot.report ?? [],
  ]);
}

function dedupeReductionSnapshots(
  snapshots: ReductionVisualSnapshot[],
): ReductionVisualSnapshot[] {
  const seen = new Set<string>();
  const out: ReductionVisualSnapshot[] = [];
  for (const snapshot of sortByAtDesc(snapshots)) {
    const identity = reductionSnapshotIdentity(snapshot);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(snapshot);
  }
  return out;
}

function sortReductionSegmentsWithinCall(
  snapshots: ReductionVisualSnapshot[],
): ReductionVisualSnapshot[] {
  return [...snapshots].sort((left, right) => {
    const itemIndexDelta = Number(right.itemIndex ?? 0) - Number(left.itemIndex ?? 0);
    if (itemIndexDelta !== 0) return itemIndexDelta;
    const blockIndexDelta = Number(right.blockIndex ?? -1) - Number(left.blockIndex ?? -1);
    if (blockIndexDelta !== 0) return blockIndexDelta;
    const savedCharsDelta = Number(right.savedChars ?? 0) - Number(left.savedChars ?? 0);
    if (savedCharsDelta !== 0) return savedCharsDelta;
    return String(right.segmentId ?? "").localeCompare(String(left.segmentId ?? ""));
  });
}

function groupReductionSnapshotsByRequest(
  snapshots: ReductionVisualSnapshot[],
): VisualReductionCallGroup[] {
  const groups = new Map<string, VisualReductionCallGroup>();
  for (const snapshot of sortByAtDesc(snapshots)) {
    const requestId = String(snapshot.requestId || "").trim() || "(unknown)";
    const current = groups.get(requestId) ?? {
      requestId,
      at: snapshot.at,
      model: snapshot.model,
      upstreamModel: snapshot.upstreamModel,
      totalSavedChars: 0,
      segmentCount: 0,
      toolNames: [],
      routes: [],
      dataPaths: [],
      segments: [],
    };
    if (String(snapshot.at) > current.at) {
      current.at = snapshot.at;
      current.model = snapshot.model;
      current.upstreamModel = snapshot.upstreamModel;
    }
    current.totalSavedChars += Number(snapshot.savedChars ?? 0);
    current.segmentCount += 1;
    current.toolNames = stableUnique([...current.toolNames, snapshot.toolName ?? ""]);
    current.routes = stableUnique([...current.routes, snapshot.route ?? ""]);
    current.dataPaths = stableUnique([...current.dataPaths, snapshot.dataPath ?? ""]);
    current.segments.push(snapshot);
    groups.set(requestId, current);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      segments: sortReductionSegmentsWithinCall(group.segments),
    }))
    .sort((left, right) => String(right.at).localeCompare(String(left.at)));
}

function groupVisualCacheAuditEntries(
  entries: VisualCacheAuditEntry[],
): VisualCacheAuditGroup[] {
  const groups = new Map<string, VisualCacheAuditGroup>();
  for (const entry of entries) {
    const fingerprint = String(entry.stablePrefixFingerprint || "").trim() || "(unknown)";
    const current = groups.get(fingerprint) ?? {
      stablePrefixFingerprint: fingerprint,
      latestAt: entry.at,
      latestModel: entry.model,
      requestCount: 0,
      warmHitCount: 0,
      rewriteCount: 0,
      originalRequestPromptCacheKeys: [],
      requestPromptCacheKeys: [],
      responsePromptCacheKeys: [],
      entropyKinds: [],
      driftKeys: [],
    };
    current.requestCount += 1;
    if (Number(entry.cachedInputTokens ?? 0) > 0) current.warmHitCount += 1;
    if (
      entry.requestPromptCacheKey
      && entry.responsePromptCacheKey
      && entry.requestPromptCacheKey !== entry.responsePromptCacheKey
    ) {
      current.rewriteCount += 1;
    }
    if (String(entry.at) > current.latestAt) {
      current.latestAt = entry.at;
      current.latestModel = entry.model;
    }
    current.originalRequestPromptCacheKeys = stableUnique([
      ...current.originalRequestPromptCacheKeys,
      entry.originalRequestPromptCacheKey ?? "",
    ]);
    current.requestPromptCacheKeys = stableUnique([
      ...current.requestPromptCacheKeys,
      entry.requestPromptCacheKey ?? "",
    ]);
    current.responsePromptCacheKeys = stableUnique([
      ...current.responsePromptCacheKeys,
      entry.responsePromptCacheKey ?? "",
    ]);
    current.entropyKinds = stableUnique([
      ...current.entropyKinds,
      ...(Array.isArray(entry.entropyKinds) ? entry.entropyKinds : []),
    ]);
    current.driftKeys = stableUnique([
      ...current.driftKeys,
      ...(Array.isArray(entry.driftKeys) ? entry.driftKeys : []),
    ]);
    groups.set(fingerprint, current);
  }
  return [...groups.values()].sort((left, right) => String(right.latestAt).localeCompare(String(left.latestAt)));
}

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
  return readVisualSessionDataWithOptions(stateDir, sessionId);
}

export async function readVisualSessionDataWithOptions(
  stateDir: string,
  sessionId: string,
  options?: {
    stabilityLimit?: number;
    reductionCallLimit?: number;
    evictionLimit?: number;
  },
): Promise<VisualSessionData> {
  const allStability = sortByAtDesc(await readSnapshotFile<StabilityVisualSnapshot>(snapshotCandidates(stateDir, "stability", sessionId)));
  const allReduction = dedupeReductionSnapshots(
    await readSnapshotFile<ReductionVisualSnapshot>(snapshotCandidates(stateDir, "reduction", sessionId)),
  );
  const allEviction = sortByAtDesc(await readSnapshotFile<EvictionVisualSnapshot>(snapshotCandidates(stateDir, "eviction", sessionId)));
  const [uxAggregate, recentMetrics, cacheAuditRecords, moduleSummary] = await Promise.all([
    readJsonFile<VisualUxAggregate>(uxAggregateCandidates(stateDir, sessionId)),
    readRecentReductionMetrics(stateDir, sessionId),
    readRecentCacheAuditRecordsForSession(stateDir, sessionId, 64),
    readSessionModuleObservationSummary(stateDir, sessionId),
  ]);
  const cacheAuditSummary = cacheAuditRecords.length > 0 ? summarizeCacheAudit(cacheAuditRecords) : null;
  const cacheAuditWindow = sortByAtDesc(cacheAuditRecords).map(toVisualCacheAuditEntry);
  const recentCacheAudit = cacheAuditWindow.slice(0, 8);
  const allReductionCalls = groupReductionSnapshotsByRequest(allReduction);
  const stabilityLimit = Number.isFinite(options?.stabilityLimit)
    ? Math.max(0, Math.trunc(options?.stabilityLimit ?? 0))
    : undefined;
  const reductionCallLimit = Number.isFinite(options?.reductionCallLimit)
    ? Math.max(0, Math.trunc(options?.reductionCallLimit ?? 0))
    : undefined;
  const evictionLimit = Number.isFinite(options?.evictionLimit)
    ? Math.max(0, Math.trunc(options?.evictionLimit ?? 0))
    : undefined;
  const stability = typeof stabilityLimit === "number" ? allStability.slice(0, stabilityLimit) : allStability;
  const reductionCalls = typeof reductionCallLimit === "number"
    ? allReductionCalls.slice(0, reductionCallLimit)
    : allReductionCalls;
  const allowedRequestIds = new Set(reductionCalls.map((group) => group.requestId));
  const reduction = allReduction.filter((snapshot) => allowedRequestIds.has(snapshot.requestId));
  const eviction = typeof evictionLimit === "number" ? allEviction.slice(0, evictionLimit) : allEviction;
  return {
    sessionId,
    stability,
    reduction,
    reductionCalls,
    eviction,
    uxAggregate,
    recentReduction: recentMetrics ? summarizeRecentReductionMetrics(recentMetrics) : null,
    cacheAuditSummary,
    cacheAuditWindow,
    recentCacheAudit,
    recentCacheAuditGroups: groupVisualCacheAuditEntries(recentCacheAudit),
    moduleSummary,
    limits: {
      stabilityTotal: allStability.length,
      stabilityReturned: stability.length,
      reductionTotal: allReduction.length,
      reductionReturned: reduction.length,
      reductionCallTotal: allReductionCalls.length,
      reductionCallReturned: reductionCalls.length,
      evictionTotal: allEviction.length,
      evictionReturned: eviction.length,
    },
  };
}

export async function readVisualSessionList(stateDir: string): Promise<VisualSessionSummary[]> {
  return (await readVisualSessionListWithOptions(stateDir)).sessions;
}

export async function readVisualSessionListWithOptions(
  stateDir: string,
  options?: {
    limit?: number;
    offset?: number;
    detailsScope?: "all" | "returned";
  },
): Promise<VisualSessionListResult> {
  const stabilityFiles = await listSnapshotFiles(stateDir, "stability");
  const reductionFiles = await listSnapshotFiles(stateDir, "reduction");
  const evictionFiles = await listSnapshotFiles(stateDir, "eviction");
  const moduleObservationSummaries = await listSessionModuleObservationSummaries(stateDir);
  const summaryBySessionId = new Map<string, VisualSessionSummary>();

  const mergeCount = async (kind: "stability" | "reduction" | "eviction", fileName: string) => {
    const sessionId = decodeURIComponent(basename(fileName, ".jsonl"));
    const summary = summaryBySessionId.get(sessionId) ?? {
      sessionId,
      stabilityCount: 0,
      reductionCount: 0,
      evictionCount: 0,
      lastAt: "",
      latestCountMode: undefined,
      tokenOptimizedTurns: 0,
      tokenSavedCount: 0,
      charOptimizedTurns: 0,
      charSavedCount: 0,
      cacheAuditSummary: null,
    };
    if (kind === "stability") {
      const snapshots = await readSnapshotFile<StabilityVisualSnapshot>(snapshotCandidates(stateDir, "stability", sessionId));
      if (snapshots.length === 0) return;
      summary.stabilityCount = snapshots.length;
      const latestAt = latestAtOf(snapshots);
      if (latestAt > summary.lastAt) summary.lastAt = latestAt;
    } else if (kind === "reduction") {
      const snapshots = dedupeReductionSnapshots(
        await readSnapshotFile<ReductionVisualSnapshot>(snapshotCandidates(stateDir, "reduction", sessionId)),
      );
      if (snapshots.length === 0) return;
      summary.reductionCount = groupReductionSnapshotsByRequest(snapshots).length;
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
  for (const moduleSummary of moduleObservationSummaries) {
    const sessionId = String(moduleSummary.sessionId ?? "").trim();
    if (!sessionId) continue;
    const summary = summaryBySessionId.get(sessionId) ?? {
      sessionId,
      stabilityCount: 0,
      reductionCount: 0,
      evictionCount: 0,
      lastAt: "",
      latestCountMode: undefined,
      tokenOptimizedTurns: 0,
      tokenSavedCount: 0,
      charOptimizedTurns: 0,
      charSavedCount: 0,
      cacheAuditSummary: null,
    };
    const latestAt = String(moduleSummary.latestAt ?? "");
    if (latestAt > summary.lastAt) summary.lastAt = latestAt;
    summaryBySessionId.set(sessionId, summary);
  }

  const ordered = [...summaryBySessionId.values()].sort((left, right) => right.lastAt.localeCompare(left.lastAt));
  const total = ordered.length;
  const offset = Number.isFinite(options?.offset) ? Math.max(0, Math.trunc(options?.offset ?? 0)) : 0;
  const limit = Number.isFinite(options?.limit) ? Math.max(0, Math.trunc(options?.limit ?? 0)) : total;
  const paged = ordered.slice(offset, offset + limit);
  const detailsScope = options?.detailsScope === "returned" ? "returned" : "all";
  const enrichTargets = detailsScope === "returned" ? paged : ordered;

  await Promise.all(enrichTargets.map(async (summary) => {
    const [uxAggregate, cacheAuditSummary] = await Promise.all([
      readJsonFile<VisualUxAggregate>(uxAggregateCandidates(stateDir, summary.sessionId)),
      readRecentCacheAuditRecordsForSession(stateDir, summary.sessionId, 64).then((records) => (
        records.length > 0 ? summarizeCacheAudit(records) : null
      )),
    ]);
    summary.cacheAuditSummary = cacheAuditSummary;
    if (!uxAggregate) return;
    summary.latestCountMode = typeof uxAggregate.latestCountMode === "string"
      ? uxAggregate.latestCountMode
      : summary.latestCountMode;
    summary.tokenOptimizedTurns = Number(uxAggregate.tokenOptimizedTurns ?? summary.tokenOptimizedTurns ?? 0);
    summary.tokenSavedCount = Number(uxAggregate.tokenSavedCount ?? summary.tokenSavedCount ?? 0);
    summary.charOptimizedTurns = Number(uxAggregate.charOptimizedTurns ?? summary.charOptimizedTurns ?? 0);
    summary.charSavedCount = Number(uxAggregate.charSavedCount ?? summary.charSavedCount ?? 0);
    if (typeof uxAggregate.latestAt === "string" && uxAggregate.latestAt > summary.lastAt) {
      summary.lastAt = uxAggregate.latestAt;
    }
  }));

  return {
    sessions: paged,
    total,
    offset,
    limit,
    totals: {
      stabilityCount: ordered.reduce((sum, session) => sum + Number(session.stabilityCount ?? 0), 0),
      reductionCount: ordered.reduce((sum, session) => sum + Number(session.reductionCount ?? 0), 0),
      evictionCount: ordered.reduce((sum, session) => sum + Number(session.evictionCount ?? 0), 0),
      latestAt: ordered.reduce((latest, session) => String(session.lastAt ?? "") > latest ? String(session.lastAt ?? "") : latest, ""),
    },
  };
}
