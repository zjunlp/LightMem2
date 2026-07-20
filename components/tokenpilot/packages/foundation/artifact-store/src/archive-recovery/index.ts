import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  archiveDirWriteTargets,
  defaultArchiveDir,
  defaultArchiveLookupDirs,
  defaultPluginStateDir,
  pluginStateSubdirCandidates,
  hashText,
  sanitizePathPart,
} from "./archive-paths.js";

export type GenericArchiveEntry = {
  schemaVersion: number;
  kind: string;
  sessionId: string;
  segmentId: string;
  sourcePass: string;
  toolName: string;
  dataKey: string;
  originalText: string;
  originalSize: number;
  archivedAt: string;
  metadata?: Record<string, unknown>;
};

export type RecoveredArchiveRenderResult = {
  text: string;
  details: {
    originalSize: number;
    sourcePass: string;
    toolName: string;
    recovered: true;
    recoveredStartLine?: number;
    recoveredEndLine?: number;
    recoveredLineCount?: number;
  };
};

type ArchiveContentParams = {
  sessionId: string;
  segmentId: string;
  sourcePass: string;
  toolName: string;
  dataKey: string;
  originalText: string;
  workspaceDir?: string;
  archiveDir?: string;
  metadata?: Record<string, unknown>;
};

type ArchiveLocationParams = {
  sessionId: string;
  segmentId: string;
  workspaceDir?: string;
  archiveDir?: string;
};

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

export function isMemoryFaultRecoveryEnabled(): boolean {
  const raw = process.env.TOKENPILOT_MEMORY_FAULT_RECOVERY_ENABLED;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return true;
  }
  return TRUE_ENV_VALUES.has(raw.trim().toLowerCase());
}

export function buildRecoveryHint(params: {
  dataKey: string;
  originalSize: number;
  archivePath: string;
  sourceLabel: string;
  enabled?: boolean;
}): string {
  const { dataKey, originalSize, archivePath, sourceLabel, enabled } = params;
  const effectiveEnabled = (enabled ?? true) && isMemoryFaultRecoveryEnabled();
  if (!effectiveEnabled) return "";
  return (
    `\n\n[${sourceLabel}] Full content omitted to save context (${originalSize.toLocaleString()} chars).\n` +
    `To recover it, call the tool memory_fault_recover with {\"dataKey\":\"${dataKey}\"}.\n` +
    `For a focused code window, you may instead call memory_fault_recover with {\"dataKey\":\"${dataKey}\",\"startLine\":20,\"endLine\":80}.\n` +
    `This is an internal recovery read; do not call the original tool again for this content.\n` +
    `Archive: ${archivePath}`
  );
}

export function renderRecoveredArchive(params: {
  dataKey: string;
  archive: GenericArchiveEntry;
  startLine?: number;
  endLine?: number;
}): RecoveredArchiveRenderResult {
  const startLine = typeof params.startLine === "number" && Number.isFinite(params.startLine)
    ? Math.max(1, Math.trunc(params.startLine))
    : undefined;
  const endLine = typeof params.endLine === "number" && Number.isFinite(params.endLine)
    ? Math.max(1, Math.trunc(params.endLine))
    : undefined;
  const lines = params.archive.originalText.split("\n");
  const hasLineWindow = startLine != null || endLine != null;
  const boundedStart = startLine ?? 1;
  const boundedEnd = Math.min(endLine ?? lines.length, lines.length);
  const recoveredText = hasLineWindow
    ? lines.slice(Math.max(0, boundedStart - 1), Math.max(0, boundedEnd)).join("\n")
    : params.archive.originalText;

  return {
    text:
      `[Memory Fault Recovery] Recovered content for: ${params.dataKey}\n`
      + `Original size: ${params.archive.originalSize.toLocaleString()} chars\n`
      + (hasLineWindow ? `Recovered lines: ${boundedStart}-${boundedEnd}\n` : "")
      + `Archived by: ${params.archive.sourcePass}\n`
      + `--- Recovered Content ---\n`
      + `${recoveredText}\n`
      + "--- End Recovered Content ---",
    details: {
      originalSize: params.archive.originalSize,
      sourcePass: params.archive.sourcePass,
      toolName: params.archive.toolName,
      recovered: true,
      ...(hasLineWindow
        ? {
            recoveredStartLine: boundedStart,
            recoveredEndLine: boundedEnd,
            recoveredLineCount: Math.max(0, boundedEnd - boundedStart + 1),
          }
        : {}),
    },
  };
}

export async function archiveContent(params: ArchiveContentParams): Promise<{
  archivePath: string;
  archiveDir: string;
}> {
  const entry: GenericArchiveEntry = {
    schemaVersion: 1,
    kind: `${params.sourcePass}_archive`,
    sessionId: params.sessionId,
    segmentId: params.segmentId,
    sourcePass: params.sourcePass,
    toolName: params.toolName,
    dataKey: params.dataKey,
    originalText: params.originalText,
    originalSize: params.originalText.length,
    archivedAt: new Date().toISOString(),
    metadata: params.metadata,
  };
  const primary = buildArchiveLocation(params);
  const writeDirs = archiveDirWriteTargets(primary.archiveDir);
  const fileName = primary.archivePath.slice(primary.archiveDir.length + 1);
  const payload = `${JSON.stringify(entry, null, 2)}\n`;

  for (const archiveDir of writeDirs) {
    const archivePath = join(archiveDir, fileName);
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, payload, "utf8");
    await updateArchiveLookup(params.dataKey, archivePath, archiveDir);
  }

  return primary;
}

export function buildArchiveLocation(params: ArchiveLocationParams): {
  archiveDir: string;
  archivePath: string;
} {
  const archiveDir = params.archiveDir ?? defaultArchiveDir(params.sessionId, params.workspaceDir);
  const timestamp = Date.now();
  const fileName = `${timestamp}-${sanitizePathPart(params.segmentId)}.json`;
  const archivePath = join(archiveDir, fileName);
  return { archiveDir, archivePath };
}

export async function updateArchiveLookup(
  dataKey: string,
  archivePath: string,
  archiveDir: string,
): Promise<void> {
  const keyDir = join(archiveDir, "keys");
  const keyPath = join(keyDir, `${hashText(dataKey)}.json`);
  await mkdir(keyDir, { recursive: true });
  await writeFile(
    keyPath,
    JSON.stringify({ dataKey, archivePath }, null, 2),
    "utf8",
  );

  const lookupPath = join(archiveDir, "key-lookup.json");
  let lookup: Record<string, string> = {};
  try {
    const raw = await readFile(lookupPath, "utf8");
    lookup = JSON.parse(raw) as Record<string, string>;
  } catch {
    lookup = {};
  }
  lookup[dataKey] = archivePath;
  await writeFile(lookupPath, JSON.stringify(lookup, null, 2), "utf8");
}

export async function readArchive(archivePath: string): Promise<GenericArchiveEntry | null> {
  try {
    const content = await readFile(archivePath, "utf8");
    const parsed = JSON.parse(content);
    if (typeof parsed?.originalText !== "string") return null;
    if (typeof parsed?.dataKey !== "string") return null;
    if (typeof parsed?.toolName !== "string") return null;
    return parsed as GenericArchiveEntry;
  } catch {
    return null;
  }
}

export async function resolveArchivePathFromLookup(
  dataKey: string,
  stateDir: string,
  sessionId: string,
): Promise<string | null> {
  const candidates = defaultArchiveLookupDirs(sessionId, stateDir);
  if (sessionId !== "proxy-session") {
    candidates.push(...defaultArchiveLookupDirs("proxy-session", stateDir));
  }
  for (const archiveDir of candidates) {
    const keyPath = join(archiveDir, "keys", `${hashText(dataKey)}.json`);
    try {
      const raw = await readFile(keyPath, "utf8");
      const parsed = JSON.parse(raw) as { dataKey?: string; archivePath?: string };
      if (parsed?.dataKey === dataKey && typeof parsed.archivePath === "string" && parsed.archivePath) {
        return parsed.archivePath;
      }
    } catch {
      // Try next lookup strategy.
    }

    const lookupPath = join(archiveDir, "key-lookup.json");
    try {
      const raw = await readFile(lookupPath, "utf8");
      const lookup = JSON.parse(raw) as Record<string, string>;
      const found = lookup[dataKey];
      if (found) return found;
    } catch {
      // Try next lookup strategy.
    }

    try {
      const entries = await readdir(archiveDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "key-lookup.json") {
          continue;
        }
        const archivePath = join(archiveDir, entry.name);
        const archive = await readArchive(archivePath);
        if (archive?.dataKey === dataKey) {
          await updateArchiveLookup(dataKey, archivePath, archiveDir);
          return archivePath;
        }
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

export async function resolveArchivePathAcrossSessions(
  dataKey: string,
  stateDir: string,
): Promise<string | null> {
  const sessionRootCandidates = pluginStateSubdirCandidates(stateDir, "tool-result-archives");
  for (const sessionRoot of sessionRootCandidates) {
    try {
      const entries = await readdir(sessionRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = await resolveArchivePathFromLookup(dataKey, stateDir, entry.name);
        if (found) return found;
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

export function resolveRecoveryStateDir(stateDir?: string): string {
  return stateDir ?? defaultPluginStateDir();
}

export * from "./tool-result-persist.js";
