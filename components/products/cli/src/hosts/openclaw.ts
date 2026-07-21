import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ProductSurfaceConfigAdapter,
  ProductSurfaceHostBridge,
} from "@lightmem2/host-adapter";
import { handleVisual as handleSharedVisual } from "@lightmem2/product-surface";
import { readLatestUxEffect, readSessionUxAggregate } from "../../../../adapters/openclaw/src/context-stack/integration/ux-effects.js";
import {
  readRecentOpenClawCacheAuditRecordsForSession,
} from "../../../../adapters/openclaw/src/cache-audit.js";
import { resolveOpenClawConfigPath } from "../../../../adapters/openclaw/src/context-stack/integration/openclaw-paths.js";
import { openClawProductSurfaceConfigAdapter, resolveStateDir } from "../../../../adapters/openclaw/src/commands/tokenpilot/host-config-adapter.js";
import { formatOpenClawDoctorReport, inspectOpenClawDoctor } from "../../../../adapters/openclaw/src/commands/tokenpilot/openclaw-doctor.js";
import { buildSessionReportResult, resolveConfiguredPreferredSessionId } from "./shared.js";
import {
  ensureDetachedVisualDaemon,
  resolveCliEntryPathFromHostModule,
  singleHostVisualLogPath,
  singleHostVisualMetaPath,
  singleHostVisualPidPath,
} from "./visual-daemon.js";

function normalizeSessionId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

async function loadConfig(): Promise<Record<string, unknown>> {
  const configPath = resolveOpenClawConfigPath();
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeConfig(nextConfig: Record<string, unknown>): Promise<void> {
  const configPath = resolveOpenClawConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

async function maybeResolveLatestSessionId(): Promise<string | undefined> {
  return resolveConfiguredPreferredSessionId({
    loadConfig,
    resolveStateDir,
    async resolveLatestSessionId() {
      return undefined;
    },
    readLatestUxEffect,
  });
}

async function ensureVisualServerForStateDir(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  return ensureDetachedVisualDaemon<{ url?: string; pid?: number; stateDir?: string }>({
    daemonArgs: [resolveCliEntryPathFromHostModule(__filename), "__visual_daemon_single", stateDir],
    metaPath: singleHostVisualMetaPath(stateDir),
    pidPath: singleHostVisualPidPath(stateDir),
    logPath: singleHostVisualLogPath(stateDir),
    expectedSignature: stateDir,
    readSignature(meta) {
      return meta?.stateDir;
    },
    readUrl(meta) {
      return meta?.url;
    },
    readPid(meta) {
      return meta?.pid;
    },
  });
}

export function createOpenClawCliBridge(target: {
  host: "openclaw";
  sessionId?: string;
}): {
  bridge: ProductSurfaceHostBridge;
  configAdapter: ProductSurfaceConfigAdapter;
  maybeResolveLatestSessionId(): Promise<string | undefined>;
  resolveSessionId(sessionId?: string): Promise<string | undefined>;
} {
  const bridge: ProductSurfaceHostBridge = {
    loadConfig,
    writeConfig,
    async handleDoctor(currentConfig) {
      return {
        text: formatOpenClawDoctorReport(inspectOpenClawDoctor(currentConfig)),
      };
    },
    async handleVisual(currentConfig) {
      const stateDir = resolveStateDir(currentConfig);
      const effectiveStateDir = stateDir ?? "";
      if (!effectiveStateDir) {
        return { text: "TokenPilot stateDir is not configured." };
      }
      await ensureVisualServerForStateDir(effectiveStateDir);
      return handleSharedVisual(currentConfig, resolveStateDir);
    },
    async handleReport(_ctx, currentConfig) {
      return buildSessionReportResult({
        currentConfig,
        explicitSessionId: target.sessionId,
        configAdapter: openClawProductSurfaceConfigAdapter,
        async resolveLatestSessionId() {
          return undefined;
        },
        readLatestUxEffect,
        readSessionAggregate: readSessionUxAggregate,
        async readRecentCacheAuditRecords(stateDir, sessionId) {
          return readRecentOpenClawCacheAuditRecordsForSession(stateDir, sessionId, 64);
        },
      });
    },
  };

  return {
    bridge,
    configAdapter: openClawProductSurfaceConfigAdapter,
    maybeResolveLatestSessionId,
    async resolveSessionId(sessionId?: string): Promise<string | undefined> {
      return normalizeSessionId(sessionId);
    },
  };
}
