import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ensureMultiHostVisualServer,
  startVisualServer,
  readVisualSessionList,
  type VisualHostSource,
} from "@lightmem2/product-surface";
import { resolveCliVisualHosts } from "./registry.js";
import {
  ensureDetachedVisualDaemon,
  resolveCliEntryPathFromHostModule,
  sharedVisualLogPath,
  sharedVisualMetaPath,
  sharedVisualPidPath,
  sharedVisualRootDir,
  singleHostVisualMetaPath,
} from "./visual-daemon.js";

type MultiHostVisualMeta = {
  url?: string;
  pid?: number;
  hosts?: Array<{ hostId: string; stateDir: string }>;
};

function hostSignature(hosts: VisualHostSource[]): string {
  return JSON.stringify(hosts.map((host) => ({ hostId: host.hostId, stateDir: host.stateDir })));
}

export async function ensureStandaloneVisualServer(): Promise<{
  url: string;
  hosts: VisualHostSource[];
}> {
  const hosts = await resolveCliVisualHosts();
  const nextSignature = hostSignature(hosts);
  await mkdir(sharedVisualRootDir(), { recursive: true });
  const url = await ensureDetachedVisualDaemon<MultiHostVisualMeta>({
    daemonArgs: [resolveCliEntryPathFromHostModule(__filename), "__visual_daemon_multi"],
    metaPath: sharedVisualMetaPath(),
    pidPath: sharedVisualPidPath(),
    logPath: sharedVisualLogPath(),
    expectedSignature: nextSignature,
    readSignature(meta) {
      return JSON.stringify(
        Array.isArray(meta?.hosts)
          ? meta.hosts.map((host) => ({ hostId: host.hostId, stateDir: host.stateDir }))
          : [],
      );
    },
    readUrl(meta) {
      return meta?.url;
    },
    readPid(meta) {
      return meta?.pid;
    },
  });
  return { url, hosts };
}

export async function handleStandaloneVisualCommand(): Promise<{ text: string }> {
  return handleStandaloneVisualCommandWithSelection({});
}

export async function handleStandaloneVisualCommandWithSelection(params: {
  host?: string;
  sessionId?: string;
}): Promise<{ text: string }> {
  const { url, hosts } = await ensureStandaloneVisualServer();
  const query = new URL(url);
  if (typeof params.host === "string" && params.host.trim()) {
    query.searchParams.set("host", params.host.trim());
  }
  if (typeof params.sessionId === "string" && params.sessionId.trim()) {
    query.searchParams.set("session", params.sessionId.trim());
  }
  const hostLines = await Promise.all(hosts.map(async (host) => {
    const sessions = await readVisualSessionList(host.stateDir);
    return `- ${host.displayName}: ${sessions.length} session snapshots`;
  }));
  return {
    text: [
      `LightMem2 visual: ${query.toString()}`,
      `- hosts: ${hosts.length}`,
      ...hostLines,
      "- open this URL in your browser, then switch hosts from the sidebar",
    ].join("\n"),
  };
}

export async function maybeRunVisualDaemon(argv: string[]): Promise<boolean> {
  if (argv[0] === "__visual_daemon_multi") {
    const hosts = await resolveCliVisualHosts();
    const handle = await ensureMultiHostVisualServer(hosts);
    await mkdir(dirname(sharedVisualMetaPath()), { recursive: true });
    await writeFile(
      sharedVisualMetaPath(),
      `${JSON.stringify({
        url: handle.url,
        pid: process.pid,
        hosts: hosts.map(({ hostId, stateDir }) => ({ hostId, stateDir })),
      }, null, 2)}\n`,
      "utf8",
    );
    return new Promise<boolean>(() => undefined);
  }

  if (argv[0] === "__visual_daemon_single") {
    const stateDir = String(argv[1] ?? "").trim();
    if (!stateDir) {
      throw new Error("Missing stateDir for visual daemon");
    }
    const handle = await startVisualServer(stateDir, { unref: false });
    await writeFile(
      singleHostVisualMetaPath(stateDir),
      `${JSON.stringify({ url: handle.url, pid: process.pid, stateDir }, null, 2)}\n`,
      "utf8",
    );
    return new Promise<boolean>(() => undefined);
  }

  return false;
}
