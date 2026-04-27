import { createHash } from "node:crypto";
import { join } from "node:path";

export function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function defaultPluginStateDir(): string {
  const envStateDir = process.env.TOKENPILOT_STATE_DIR || process.env.ECOCLAW_STATE_DIR;
  if (typeof envStateDir === "string" && envStateDir.trim().length > 0) {
    return envStateDir.trim();
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
  return join(homeDir, ".openclaw", "ecoclaw-plugin-state");
}

export function defaultArchiveDir(sessionId: string, workspaceDir?: string): string {
  if (workspaceDir) {
    return join(workspaceDir, ".ecoclaw-archives");
  }
  const match = sessionId.match(/-(\d+)-j(\d+)$/);
  if (match) {
    const runId = match[1];
    const jobId = match[2];
    return `/tmp/pinchbench/${runId}/agent_workspace_j${jobId}/.ecoclaw-archives`;
  }
  return join(defaultPluginStateDir(), "ecoclaw", "tool-result-archives", sanitizePathPart(sessionId));
}

export function defaultArchiveLookupDirs(sessionId: string, stateDir?: string): string[] {
  const dirs: string[] = [];
  const sessionMatch = sessionId.match(/-(\d+)-j(\d+)$/);
  if (sessionMatch) {
    dirs.push(`/tmp/pinchbench/${sessionMatch[1]}/agent_workspace_j${sessionMatch[2]}/.ecoclaw-archives`);
  }
  const resolvedStateDir = stateDir ?? defaultPluginStateDir();
  dirs.push(join(resolvedStateDir, "ecoclaw", "tool-result-archives", sessionId));
  return dirs;
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
