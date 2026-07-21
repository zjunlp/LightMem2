import { createServer, type Server } from "node:http";
import { defaultPluginStateDir } from "@lightmem2/artifact-store";
import {
  readVisualSessionData,
  readVisualSessionDataWithOptions,
  readVisualSessionList,
  readVisualSessionListWithOptions,
} from "./session-visual-data.js";
import { renderVisualPageHtml, renderVisualPageScript } from "./session-visual-page.js";

export type VisualStateDirResolver = (config: Record<string, unknown>) => string | undefined;
export type VisualServerHandle = { stateDir: string; server: Server; url: string };
export type VisualHostSource = {
  hostId: string;
  displayName: string;
  stateDir: string;
};

let visualServerState: VisualServerHandle | null = null;
let multiHostVisualServerState: (VisualServerHandle & { signature: string }) | null = null;
const DEFAULT_VISUAL_SESSION_LIMIT = 10;
const DEFAULT_VISUAL_ITEM_LIMIT = 10;

function parsePositiveIntParam(raw: string | null, fallback: number): number {
  if (raw == null || !String(raw).trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function sendJson(res: any, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendHtml(res: any, html: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}

function sendJs(res: any, script: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/javascript; charset=utf-8");
  res.end(script);
}

export async function startVisualServer(
  stateDir: string,
  options?: { unref?: boolean },
): Promise<VisualServerHandle> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true, stateDir });
        return;
      }
      if (url.pathname === "/") {
        sendHtml(res, renderVisualPageHtml());
        return;
      }
      if (url.pathname === "/app.js") {
        sendJs(res, renderVisualPageScript());
        return;
      }
      if (url.pathname === "/api/sessions") {
        const limit = parsePositiveIntParam(url.searchParams.get("limit"), DEFAULT_VISUAL_SESSION_LIMIT);
        const offset = parsePositiveIntParam(url.searchParams.get("offset"), 0);
        sendJson(res, 200, await readVisualSessionListWithOptions(stateDir, { limit, offset }));
        return;
      }
      if (url.pathname === "/api/session") {
        const sessionId = String(url.searchParams.get("sessionId") ?? "").trim();
        if (!sessionId) {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }
        const stabilityLimit = parsePositiveIntParam(url.searchParams.get("stabilityLimit"), DEFAULT_VISUAL_ITEM_LIMIT);
        const reductionCallLimit = parsePositiveIntParam(url.searchParams.get("reductionCallLimit"), DEFAULT_VISUAL_ITEM_LIMIT);
        const evictionLimit = parsePositiveIntParam(url.searchParams.get("evictionLimit"), DEFAULT_VISUAL_ITEM_LIMIT);
        sendJson(res, 200, await readVisualSessionDataWithOptions(stateDir, sessionId, {
          stabilityLimit,
          reductionCallLimit,
          evictionLimit,
        }));
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (options?.unref) server.unref();

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve visual server address.");
  }

  return {
    stateDir,
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function normalizeVisualHostSources(hosts: VisualHostSource[]): VisualHostSource[] {
  const deduped = new Map<string, VisualHostSource>();
  for (const host of hosts) {
    const hostId = String(host.hostId ?? "").trim();
    const displayName = String(host.displayName ?? "").trim();
    const stateDir = String(host.stateDir ?? "").trim();
    if (!hostId || !displayName || !stateDir) continue;
    deduped.set(hostId, {
      hostId,
      displayName,
      stateDir,
    });
  }
  return [...deduped.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

async function loadVisualHostsSummary(hosts: VisualHostSource[]): Promise<Array<{
  hostId: string;
  displayName: string;
  sessionCount: number;
  stabilityCount: number;
  reductionCount: number;
  evictionCount: number;
  tokenSavedCount: number;
  charSavedCount: number;
  tokenOptimizedTurns: number;
  charOptimizedTurns: number;
  latestCountMode?: string;
  latestAt: string;
  cacheWarmCandidates: number;
  cacheWarmHits: number;
  cacheWarmMisses: number;
  cacheHitRatePercent: number;
  cacheKeyMismatchCount: number;
}>> {
  const normalized = normalizeVisualHostSources(hosts);
  return Promise.all(normalized.map(async (host) => {
    const sessionList = await readVisualSessionListWithOptions(host.stateDir, {
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
      detailsScope: "returned",
    });
    const sessions = sessionList.sessions;
    const tokenSavedCount = sessions.reduce((sum, session) => sum + Number(session.tokenSavedCount ?? 0), 0);
    const charSavedCount = sessions.reduce((sum, session) => sum + Number(session.charSavedCount ?? 0), 0);
    return {
      hostId: host.hostId,
      displayName: host.displayName,
      sessionCount: sessionList.total,
      stabilityCount: sessionList.totals.stabilityCount,
      reductionCount: sessionList.totals.reductionCount,
      evictionCount: sessionList.totals.evictionCount,
      tokenSavedCount,
      charSavedCount,
      tokenOptimizedTurns: sessions.reduce((sum, session) => sum + Number(session.tokenOptimizedTurns ?? 0), 0),
      charOptimizedTurns: sessions.reduce((sum, session) => sum + Number(session.charOptimizedTurns ?? 0), 0),
      latestCountMode: tokenSavedCount > 0 ? "openai_tokens" : (charSavedCount > 0 ? "chars" : undefined),
      latestAt: sessionList.totals.latestAt,
      cacheWarmCandidates: sessions.reduce((sum, session) => sum + Number(session.cacheAuditSummary?.warmCandidates ?? 0), 0),
      cacheWarmHits: sessions.reduce((sum, session) => sum + Number(session.cacheAuditSummary?.warmHits ?? 0), 0),
      cacheWarmMisses: sessions.reduce((sum, session) => sum + Number(session.cacheAuditSummary?.warmMisses ?? 0), 0),
      cacheHitRatePercent: 0,
      cacheKeyMismatchCount: sessions.reduce((sum, session) => sum + Number(session.cacheAuditSummary?.promptCacheKeyMismatchCount ?? 0), 0),
    };
  })).then((hostSummaries) => hostSummaries.map((host) => ({
    ...host,
    cacheHitRatePercent:
      host.cacheWarmCandidates > 0
        ? Math.round((host.cacheWarmHits / host.cacheWarmCandidates) * 1000) / 10
        : 0,
  })));
}

export async function startMultiHostVisualServer(
  hosts: VisualHostSource[],
  options?: { unref?: boolean },
): Promise<VisualServerHandle> {
  const normalizedHosts = normalizeVisualHostSources(hosts);
  const stateDir = normalizedHosts.map((host) => `${host.hostId}:${host.stateDir}`).join("|");
  const hostById = new Map(normalizedHosts.map((host) => [host.hostId, host] as const));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          hosts: normalizedHosts.map(({ hostId, displayName, stateDir }) => ({ hostId, displayName, stateDir })),
        });
        return;
      }
      if (url.pathname === "/") {
        sendHtml(res, renderVisualPageHtml());
        return;
      }
      if (url.pathname === "/app.js") {
        sendJs(res, renderVisualPageScript());
        return;
      }
      if (url.pathname === "/api/hosts") {
        sendJson(res, 200, { hosts: await loadVisualHostsSummary(normalizedHosts) });
        return;
      }
      if (url.pathname === "/api/sessions") {
        const hostId = String(url.searchParams.get("host") ?? "").trim();
        const host = hostById.get(hostId) ?? normalizedHosts[0];
        if (!host) {
          sendJson(res, 200, { hostId: "", sessions: [], total: 0, offset: 0, limit: DEFAULT_VISUAL_SESSION_LIMIT });
          return;
        }
        const limit = parsePositiveIntParam(url.searchParams.get("limit"), DEFAULT_VISUAL_SESSION_LIMIT);
        const offset = parsePositiveIntParam(url.searchParams.get("offset"), 0);
        const payload = await readVisualSessionListWithOptions(host.stateDir, { limit, offset });
        sendJson(res, 200, {
          hostId: host.hostId,
          ...payload,
        });
        return;
      }
      if (url.pathname === "/api/session") {
        const hostId = String(url.searchParams.get("host") ?? "").trim();
        const host = hostById.get(hostId) ?? normalizedHosts[0];
        if (!host) {
          sendJson(res, 404, { error: "host is required" });
          return;
        }
        const sessionId = String(url.searchParams.get("sessionId") ?? "").trim();
        if (!sessionId) {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }
        const stabilityLimit = parsePositiveIntParam(url.searchParams.get("stabilityLimit"), DEFAULT_VISUAL_ITEM_LIMIT);
        const reductionCallLimit = parsePositiveIntParam(url.searchParams.get("reductionCallLimit"), DEFAULT_VISUAL_ITEM_LIMIT);
        const evictionLimit = parsePositiveIntParam(url.searchParams.get("evictionLimit"), DEFAULT_VISUAL_ITEM_LIMIT);
        sendJson(res, 200, await readVisualSessionDataWithOptions(host.stateDir, sessionId, {
          stabilityLimit,
          reductionCallLimit,
          evictionLimit,
        }));
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (options?.unref) server.unref();

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve visual server address.");
  }

  return {
    stateDir,
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function ensureVisualServer(stateDir: string): Promise<VisualServerHandle> {
  if (visualServerState?.stateDir === stateDir) return visualServerState;
  if (visualServerState) {
    await new Promise<void>((resolve) => {
      visualServerState?.server.close(() => resolve());
    });
  }
  visualServerState = await startVisualServer(stateDir, { unref: false });
  return visualServerState;
}

export async function ensureMultiHostVisualServer(hosts: VisualHostSource[]): Promise<VisualServerHandle> {
  const normalized = normalizeVisualHostSources(hosts);
  const signature = JSON.stringify(normalized.map(({ hostId, stateDir }) => ({ hostId, stateDir })));
  if (multiHostVisualServerState?.signature === signature) return multiHostVisualServerState;
  if (multiHostVisualServerState) {
    await new Promise<void>((resolve) => {
      multiHostVisualServerState?.server.close(() => resolve());
    });
  }
  const next = await startMultiHostVisualServer(normalized, { unref: false });
  multiHostVisualServerState = {
    ...next,
    signature,
  };
  return next;
}

export async function handleVisual(
  currentConfig: Record<string, unknown>,
  resolveStateDir: VisualStateDirResolver,
): Promise<{ text: string }> {
  const stateDir = resolveStateDir(currentConfig) ?? defaultPluginStateDir();
  const visualServer = await ensureVisualServer(stateDir);
  const sessions = await readVisualSessionList(stateDir);
  const lines = [
    `LightMem2 visual: ${visualServer.url}`,
    `- sessions with snapshots: ${sessions.length}`,
    "- open this URL in your browser to inspect reduction and eviction before/after views",
  ];
  if (sessions.length === 0) {
    lines.push("- no visual snapshots yet; new reduction/eviction events will appear after future turns");
  }
  return { text: lines.join("\n") };
}
