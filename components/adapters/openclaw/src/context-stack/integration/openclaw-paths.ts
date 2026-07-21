import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveOpenClawStateRoot(): string {
  const explicit =
    String(process.env.OPENCLAW_STATE_DIR ?? "").trim()
    || String(process.env.OPENCLAW_HOME ?? "").trim();
  if (explicit) return explicit;
  return join(homedir(), ".openclaw");
}

export function resolveOpenClawConfigPath(): string {
  const explicit = String(process.env.OPENCLAW_CONFIG_PATH ?? "").trim();
  if (explicit) return explicit;
  return join(resolveOpenClawStateRoot(), "openclaw.json");
}

export function resolveOpenClawAgentsDir(): string {
  return join(resolveOpenClawStateRoot(), "agents");
}

export function resolveOpenClawSessionsRegistryPath(agentId: string): string {
  return join(resolveOpenClawAgentsDir(), agentId, "sessions", "sessions.json");
}

export function resolveOpenClawLegacyTokenPilotStateDir(): string {
  return join(resolveOpenClawStateRoot(), "tokenpilot-plugin-state");
}

export function resolveOpenClawCanonicalTokenPilotStateDir(): string {
  return join(resolveOpenClawStateRoot(), "tokenpilot-state");
}

export function resolveOpenClawTokenPilotStateDirCandidates(explicitStateDir?: string): string[] {
  const normalizedExplicit = typeof explicitStateDir === "string" ? explicitStateDir.trim() : "";
  const canonical = resolveOpenClawCanonicalTokenPilotStateDir();
  const legacy = resolveOpenClawLegacyTokenPilotStateDir();
  return Array.from(new Set([
    normalizedExplicit,
    canonical,
    legacy,
  ].filter((value) => value.length > 0)));
}

export function resolveDefaultOpenClawTokenPilotStateDir(): string {
  const explicit =
    String(process.env.LIGHTMEM2_STATE_DIR ?? "").trim()
    || String(process.env.TOKENPILOT_STATE_DIR ?? "").trim();
  if (explicit) return explicit;

  const canonical = resolveOpenClawCanonicalTokenPilotStateDir();
  const legacy = resolveOpenClawLegacyTokenPilotStateDir();

  if (existsSync(canonical)) return canonical;
  if (existsSync(legacy)) return legacy;
  return canonical;
}
