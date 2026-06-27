import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CliHostId = "openclaw" | "codex" | "claude-code";

export type CliContextState = {
  lastActiveHost?: CliHostId;
  lastSessionByHost?: Partial<Record<CliHostId, string>>;
  lastUpdatedAt?: string;
};

export function defaultCliContextPath(): string {
  return join(homedir(), ".lightmem2", "state", "cli-context.json");
}

export async function readCliContextState(
  contextPath = defaultCliContextPath(),
): Promise<CliContextState> {
  try {
    const raw = await readFile(contextPath, "utf8");
    const parsed = JSON.parse(raw) as CliContextState;
    return {
      lastActiveHost: parsed.lastActiveHost,
      lastSessionByHost: parsed.lastSessionByHost ?? {},
      lastUpdatedAt: parsed.lastUpdatedAt,
    };
  } catch {
    return {
      lastSessionByHost: {},
    };
  }
}

export async function writeCliContextState(
  state: CliContextState,
  contextPath = defaultCliContextPath(),
): Promise<void> {
  await mkdir(dirname(contextPath), { recursive: true });
  await writeFile(contextPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function updateCliContextState(
  patch: {
    host?: CliHostId;
    sessionId?: string;
  },
  contextPath = defaultCliContextPath(),
): Promise<CliContextState> {
  const current = await readCliContextState(contextPath);
  const next: CliContextState = {
    lastActiveHost: patch.host ?? current.lastActiveHost,
    lastSessionByHost: {
      ...(current.lastSessionByHost ?? {}),
    },
    lastUpdatedAt: new Date().toISOString(),
  };
  if (patch.host && patch.sessionId) {
    next.lastSessionByHost ??= {};
    next.lastSessionByHost[patch.host] = patch.sessionId;
  }
  await writeCliContextState(next, contextPath);
  return next;
}
