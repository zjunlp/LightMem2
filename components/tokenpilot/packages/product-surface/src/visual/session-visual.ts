import { createServer, type Server } from "node:http";
import { defaultPluginStateDir } from "@tokenpilot/runtime-core";
import { readVisualSessionData, readVisualSessionList } from "./session-visual-data.js";
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
        sendJson(res, 200, { sessions: await readVisualSessionList(stateDir) });
        return;
      }
      if (url.pathname === "/api/session") {
        const sessionId = String(url.searchParams.get("sessionId") ?? "").trim();
        if (!sessionId) {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }
        sendJson(res, 200, await readVisualSessionData(stateDir, sessionId));
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
  latestAt: string;
}>> {
  const normalized = normalizeVisualHostSources(hosts);
  return Promise.all(normalized.map(async (host) => {
    const sessions = await readVisualSessionList(host.stateDir);
    return {
      hostId: host.hostId,
      displayName: host.displayName,
      sessionCount: sessions.length,
      stabilityCount: sessions.reduce((sum, session) => sum + Number(session.stabilityCount ?? 0), 0),
      reductionCount: sessions.reduce((sum, session) => sum + Number(session.reductionCount ?? 0), 0),
      evictionCount: sessions.reduce((sum, session) => sum + Number(session.evictionCount ?? 0), 0),
      latestAt: sessions.reduce((latest, session) => String(session.lastAt ?? "") > latest ? String(session.lastAt ?? "") : latest, ""),
    };
  }));
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
          sendJson(res, 200, { hostId: "", sessions: [] });
          return;
        }
        sendJson(res, 200, {
          hostId: host.hostId,
          sessions: await readVisualSessionList(host.stateDir),
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
        sendJson(res, 200, await readVisualSessionData(host.stateDir, sessionId));
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
    `TokenPilot visual: ${visualServer.url}`,
    `- sessions with snapshots: ${sessions.length}`,
    "- open this URL in your browser to inspect reduction and eviction before/after views",
  ];
  if (sessions.length === 0) {
    lines.push("- no visual snapshots yet; new reduction/eviction events will appear after future turns");
  }
  return { text: lines.join("\n") };
}
