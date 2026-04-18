import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  defaultArchiveDir,
  defaultArchiveLookupDirs,
  defaultPluginStateDir,
  hashText,
  sanitizePathPart,
} from "../../composer/compaction/archive.js";

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

export function buildRecoveryHint(params: {
  dataKey: string;
  originalSize: number;
  archivePath: string;
  sourceLabel: string;
}): string {
  const { dataKey, originalSize, archivePath, sourceLabel } = params;
  return (
    `\n\n[${sourceLabel}] Full content omitted to save context (${originalSize.toLocaleString()} chars).\n` +
    `To recover it, call the tool memory_fault_recover with {\"dataKey\":\"${dataKey}\"}.\n` +
    `This is an internal recovery read; do not call the original tool again for this content.\n` +
    `Archive: ${archivePath}`
  );
}

export async function archiveContent(params: ArchiveContentParams): Promise<{
  archivePath: string;
  archiveDir: string;
}> {
  const { archiveDir, archivePath } = buildArchiveLocation(params);

  await mkdir(dirname(archivePath), { recursive: true });
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
  await writeFile(archivePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  await updateArchiveLookup(params.dataKey, archivePath, archiveDir);

  return { archivePath, archiveDir };
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

export function resolveRecoveryStateDir(stateDir?: string): string {
  return stateDir ?? defaultPluginStateDir();
}
