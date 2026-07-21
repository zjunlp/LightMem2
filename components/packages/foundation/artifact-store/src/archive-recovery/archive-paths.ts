import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StatePathResolver } from "@lightmem2/host-adapter";

export const PLUGIN_STATE_DIRNAME = "tokenpilot-plugin-state";
export const PLUGIN_NAMESPACE_DIR = "tokenpilot";
export const WORKSPACE_ARCHIVE_DIRNAME = ".tokenpilot-archives";
export const DEFAULT_HOST_NEUTRAL_STATE_ROOT = ".tokenpilot";

let statePathResolver: StatePathResolver | null = null;

export function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function configureStatePathResolver(resolver: StatePathResolver | null): void {
  statePathResolver = resolver;
}

export function currentStatePathResolver(): StatePathResolver | null {
  return statePathResolver;
}

export function pluginNamespaceDir(): string {
  return statePathResolver?.roots.namespaceDir?.trim() || PLUGIN_NAMESPACE_DIR;
}

export function workspaceArchiveDirname(): string {
  return statePathResolver?.roots.workspaceArchiveDirname?.trim() || WORKSPACE_ARCHIVE_DIRNAME;
}

export function defaultPluginStateDir(): string {
  if (statePathResolver) {
    return statePathResolver.defaultStateDir();
  }
  const lightmem2StateDir = process.env.LIGHTMEM2_STATE_DIR;
  if (typeof lightmem2StateDir === "string" && lightmem2StateDir.trim().length > 0) {
    return lightmem2StateDir.trim();
  }
  const envStateDir = process.env.TOKENPILOT_STATE_DIR;
  if (typeof envStateDir === "string" && envStateDir.trim().length > 0) {
    return envStateDir.trim();
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
  const candidate = join(homeDir, DEFAULT_HOST_NEUTRAL_STATE_ROOT, PLUGIN_STATE_DIRNAME);
  if (existsSync(candidate)) return candidate;
  return candidate;
}

export function pluginStateDirCandidates(explicitStateDir?: string): string[] {
  if (statePathResolver) {
    return statePathResolver.stateDirCandidates(explicitStateDir);
  }
  if (explicitStateDir && explicitStateDir.trim().length > 0) {
    return [explicitStateDir.trim()];
  }
  const lightmem2StateDir = process.env.LIGHTMEM2_STATE_DIR;
  if (typeof lightmem2StateDir === "string" && lightmem2StateDir.trim().length > 0) {
    return [lightmem2StateDir.trim()];
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
  return [join(homeDir, DEFAULT_HOST_NEUTRAL_STATE_ROOT, PLUGIN_STATE_DIRNAME)];
}

export function pluginStateDirWriteTargets(stateDir: string): string[] {
  return [stateDir.trim()];
}

export function pluginStateSubdir(stateDir: string, ...parts: string[]): string {
  return join(stateDir, pluginNamespaceDir(), ...parts);
}

export function pluginStateSubdirCandidates(stateDir: string, ...parts: string[]): string[] {
  return pluginStateDirCandidates(stateDir).map((root) => join(root, pluginNamespaceDir(), ...parts));
}

export function pluginStateSubdirWriteTargets(stateDir: string, ...parts: string[]): string[] {
  return pluginStateDirWriteTargets(stateDir).map((root) => join(root, pluginNamespaceDir(), ...parts));
}

export function workspaceArchiveDir(workspaceDir: string): string {
  return join(workspaceDir, workspaceArchiveDirname());
}

export function workspaceArchiveDirCandidates(workspaceDir: string): string[] {
  return [join(workspaceDir, workspaceArchiveDirname())];
}

export function archiveDirWriteTargets(archiveDir: string): string[] {
  return [archiveDir.trim()];
}

export function defaultArchiveDir(sessionId: string, workspaceDir?: string): string {
  if (workspaceDir) {
    return workspaceArchiveDir(workspaceDir);
  }
  return pluginStateSubdir(defaultPluginStateDir(), "tool-result-archives", sanitizePathPart(sessionId));
}

export function defaultArchiveLookupDirs(sessionId: string, stateDir?: string): string[] {
  const dirs: string[] = [];
  const resolvedStateDir = stateDir ?? defaultPluginStateDir();
  dirs.push(...pluginStateSubdirCandidates(resolvedStateDir, "tool-result-archives", sessionId));
  return Array.from(new Set(dirs));
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
