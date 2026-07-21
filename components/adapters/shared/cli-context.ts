import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type SharedCliHostId = "codex" | "claude-code";

type SharedCliHostPathOverrides = {
  tokenPilotConfigPath?: string;
  hostConfigPath?: string;
  hostAuxConfigPath?: string;
};

type SharedCliContextState = {
  lastActiveHost?: string;
  lastSessionByHost?: Record<string, string>;
  configPathsByHost?: Record<string, SharedCliHostPathOverrides>;
  lastUpdatedAt?: string;
};

function defaultCliContextPath(): string {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(homeDir, ".lightmem2", "state", "cli-context.json");
}

async function readSharedCliContextState(contextPath: string): Promise<SharedCliContextState> {
  try {
    const raw = await readFile(contextPath, "utf8");
    const parsed = JSON.parse(raw) as SharedCliContextState;
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

export async function rememberCliHostPathOverrides(
  host: SharedCliHostId,
  pathOverrides: SharedCliHostPathOverrides,
  contextPath = defaultCliContextPath(),
): Promise<void> {
  const current = await readSharedCliContextState(contextPath);
  const next: SharedCliContextState = {
    lastActiveHost: current.lastActiveHost,
    lastSessionByHost: current.lastSessionByHost ?? {},
    configPathsByHost: {
      ...(current.configPathsByHost ?? {}),
      [host]: {
        ...(current.configPathsByHost?.[host] ?? {}),
        ...pathOverrides,
      },
    },
    lastUpdatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(contextPath), { recursive: true });
  await writeFile(contextPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
