import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliHostId } from "./hosts/registry.js";

export type CliHostPathOverrides = {
  tokenPilotConfigPath?: string;
  hostConfigPath?: string;
  hostAuxConfigPath?: string;
};

export type CliContextState = {
  lastActiveHost?: CliHostId;
  lastSessionByHost?: Partial<Record<CliHostId, string>>;
  configPathsByHost?: Partial<Record<CliHostId, CliHostPathOverrides>>;
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
      configPathsByHost: parsed.configPathsByHost ?? {},
      lastUpdatedAt: parsed.lastUpdatedAt,
    };
  } catch {
    return {
      lastSessionByHost: {},
      configPathsByHost: {},
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

export async function readCliHostPathOverrides(
  host: CliHostId,
  contextPath = defaultCliContextPath(),
): Promise<CliHostPathOverrides | undefined> {
  const state = await readCliContextState(contextPath);
  return state.configPathsByHost?.[host];
}

export async function updateCliContextState(
  patch: {
    host?: CliHostId;
    sessionId?: string;
    pathOverrides?: CliHostPathOverrides;
  },
  contextPath = defaultCliContextPath(),
): Promise<CliContextState> {
  const current = await readCliContextState(contextPath);
  const next: CliContextState = {
    lastActiveHost: patch.host ?? current.lastActiveHost,
    lastSessionByHost: {
      ...(current.lastSessionByHost ?? {}),
    },
    configPathsByHost: {
      ...(current.configPathsByHost ?? {}),
    },
    lastUpdatedAt: new Date().toISOString(),
  };
  if (patch.host && patch.sessionId) {
    next.lastSessionByHost ??= {};
    next.lastSessionByHost[patch.host] = patch.sessionId;
  }
  if (patch.host && patch.pathOverrides) {
    next.configPathsByHost ??= {};
    next.configPathsByHost[patch.host] = {
      ...(next.configPathsByHost[patch.host] ?? {}),
      ...patch.pathOverrides,
    };
  }
  await writeCliContextState(next, contextPath);
  return next;
}
