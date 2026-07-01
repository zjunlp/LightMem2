import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_TOKENPILOT_MCP_INSTALL_PROBE_TIMEOUT_MS,
  DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
  probeTokenPilotMcpServer,
  resolveTokenPilotMcpProbeServerSpec,
  resolveTokenPilotMcpServerSpec,
  type TokenPilotMcpServerSpec,
} from "../../../products/mcp/src/index.js";
import {
  CLAUDE_TOOL_SEARCH_DEFAULT,
  CLAUDE_TOOL_SEARCH_ENV,
  defaultClaudeCodeMcpConfigPath,
  defaultClaudeCodeSettingsPath,
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
  proxyBaseUrlForPort,
  writeTokenPilotClaudeCodeConfig,
} from "./config.js";
import {
  defaultClaudeCodeSkillBridgeDir,
  installCommandSkillBridge,
} from "../../shared/command-skill-bridge.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function adapterRootFromHere(): string {
  const moduleDir = __dirname;
  const fromDist = resolve(moduleDir, "..");
  if (existsSync(join(fromDist, "package.json"))) {
    return fromDist;
  }
  const fromSrc = resolve(moduleDir, "..");
  if (existsSync(join(fromSrc, "package.json"))) {
    return fromSrc;
  }
  return join(process.cwd(), "components", "tokenpilot", "adapters", "claude-code");
}

function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function tokenPilotHookCommand(adapterRoot: string): string {
  const distHandler = resolve(adapterRoot, "dist", "hooks-handler.js");
  if (existsSync(distHandler)) {
    return `${shellQuote(process.execPath)} ${shellQuote(distHandler)}`;
  }
  const srcHandler = resolve(adapterRoot, "src", "hooks-handler.ts");
  return `${shellQuote(process.execPath)} --import tsx ${shellQuote(srcHandler)}`;
}

export function resolveClaudeCodeHookCommandForInstall(): string {
  return tokenPilotHookCommand(adapterRootFromHere());
}

export function resolveClaudeCodeMcpServerSpecForInstall(stateDir: string): TokenPilotMcpServerSpec {
  return resolveTokenPilotMcpServerSpec({
    stateDir,
  });
}

export function resolveClaudeCodeMcpServerSpecForProbe(stateDir: string): TokenPilotMcpServerSpec {
  return resolveTokenPilotMcpProbeServerSpec({
    stateDir,
  });
}

function isTokenPilotHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  const command = record.command;
  return typeof command === "string" && command.includes("hooks-handler.");
}

function upsertHookGroup(groups: unknown, group: Record<string, unknown>): Record<string, unknown>[] {
  const list = Array.isArray(groups)
    ? groups.filter((item) => item && typeof item === "object") as Record<string, unknown>[]
    : [];
  const filtered = list.filter((item) => {
    const hooks = Array.isArray(item.hooks) ? item.hooks : [];
    return !hooks.some(isTokenPilotHookEntry);
  });
  filtered.push(group);
  return filtered;
}

export async function installClaudeCodeTokenPilot(params?: {
  settingsPath?: string;
  tokenPilotConfigPath?: string;
  mcpConfigPath?: string;
  probeMcp?: boolean;
}): Promise<{
  settingsPath: string;
  mcpConfigPath: string;
  tokenPilotConfigPath: string;
  proxyBaseUrl: string;
  stateDir: string;
  settingsBackedUp: boolean;
  mcpConfigBackedUp: boolean;
  hooksInstalled: boolean;
  toolSearchEnvName: string;
  toolSearchEnvValue: string;
  mcpServerName: string;
  expectedHookCommand: string;
  expectedMcpCommand: string;
  expectedMcpArgs: string[];
  expectedMcpStartupTimeoutSec: number;
  commandSkillsDir: string;
  commandSkillNames: string[];
  mcpProbe: {
    ok: boolean;
    detail: string;
    timedOut: boolean;
    degraded: boolean;
  };
}> {
  const settingsPath = params?.settingsPath ?? defaultClaudeCodeSettingsPath();
  const mcpConfigPath = params?.mcpConfigPath ?? defaultClaudeCodeMcpConfigPath();
  const tokenPilotConfigPath = params?.tokenPilotConfigPath ?? defaultTokenPilotClaudeCodeConfigPath();
  const config = await loadTokenPilotClaudeCodeConfig(tokenPilotConfigPath);
  const commandSkillsDir = defaultClaudeCodeSkillBridgeDir(settingsPath);
  await writeTokenPilotClaudeCodeConfig(config, tokenPilotConfigPath);
  const mcpServer = resolveClaudeCodeMcpServerSpecForInstall(config.stateDir);
  const mcpProbeServer = resolveClaudeCodeMcpServerSpecForProbe(config.stateDir);

  const existing = existsSync(settingsPath)
    ? JSON.parse(await readFile(settingsPath, "utf8"))
    : {};
  const root = asRecord(existing);
  const env = {
    ...asRecord(root.env),
    ANTHROPIC_BASE_URL: proxyBaseUrlForPort(config.proxyPort),
    [CLAUDE_TOOL_SEARCH_ENV]: CLAUDE_TOOL_SEARCH_DEFAULT,
  };
  const hooks = asRecord(root.hooks);
  const command = resolveClaudeCodeHookCommandForInstall();
  const handler = () => ({
    type: "command",
    command,
  });
  hooks.SessionStart = upsertHookGroup(hooks.SessionStart, { hooks: [handler()] });
  hooks.PreToolUse = upsertHookGroup(hooks.PreToolUse, { hooks: [handler()] });
  hooks.PostToolUse = upsertHookGroup(hooks.PostToolUse, { hooks: [handler()] });
  hooks.Stop = upsertHookGroup(hooks.Stop, { hooks: [handler()] });
  hooks.SessionEnd = upsertHookGroup(hooks.SessionEnd, { hooks: [handler()] });
  const next = {
    ...root,
    env,
    hooks,
  };

  await mkdir(dirname(settingsPath), { recursive: true });
  const settingsBackedUp = existsSync(settingsPath);
  if (existsSync(settingsPath)) {
    await copyFile(settingsPath, `${settingsPath}.tokenpilot.bak`);
  }
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  const mcpExisting = existsSync(mcpConfigPath)
    ? JSON.parse(await readFile(mcpConfigPath, "utf8"))
    : {};
  const mcpRoot = asRecord(mcpExisting);
  const mcpServers = {
    ...asRecord(mcpRoot.mcpServers),
    [mcpServer.serverName]: {
      command: mcpServer.command,
      args: mcpServer.args,
      env: mcpServer.env,
      startup_timeout_sec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
    },
  };
  await mkdir(dirname(mcpConfigPath), { recursive: true });
  const mcpConfigBackedUp = existsSync(mcpConfigPath);
  if (existsSync(mcpConfigPath)) {
    await copyFile(mcpConfigPath, `${mcpConfigPath}.tokenpilot.bak`);
  }
  await writeFile(mcpConfigPath, `${JSON.stringify({ ...mcpRoot, mcpServers }, null, 2)}\n`, "utf8");
  const commandSkillBridge = await installCommandSkillBridge({
    adapterRoot: adapterRootFromHere(),
    skillsDir: commandSkillsDir,
    host: "claude-code",
    style: "claude",
  });
  const mcpProbe = params?.probeMcp === false
    ? {
      ok: false,
      timedOut: false,
      degraded: true,
      detail: "MCP startup probe skipped by installer options",
    }
    : await probeTokenPilotMcpServer(mcpProbeServer, {
      timeoutMs: DEFAULT_TOKENPILOT_MCP_INSTALL_PROBE_TIMEOUT_MS,
      clientName: "tokenpilot-claude-code-install",
      clientVersion: "0.1.0",
    });
  return {
    settingsPath,
    mcpConfigPath,
    tokenPilotConfigPath,
    proxyBaseUrl: proxyBaseUrlForPort(config.proxyPort),
    stateDir: config.stateDir,
    settingsBackedUp,
    mcpConfigBackedUp,
    hooksInstalled: true,
    toolSearchEnvName: CLAUDE_TOOL_SEARCH_ENV,
    toolSearchEnvValue: CLAUDE_TOOL_SEARCH_DEFAULT,
    mcpServerName: mcpServer.serverName,
    expectedHookCommand: command,
    expectedMcpCommand: mcpServer.command,
    expectedMcpArgs: mcpServer.args,
    expectedMcpStartupTimeoutSec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
    commandSkillsDir: commandSkillBridge.skillsDir,
    commandSkillNames: commandSkillBridge.skillNames,
    mcpProbe: {
      ...mcpProbe,
      degraded: !mcpProbe.ok,
    },
  };
}
