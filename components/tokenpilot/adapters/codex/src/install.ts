import { existsSync, readFileSync } from "node:fs";
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
  defaultCodexConfigPath,
  defaultHooksConfigPath,
  defaultTokenPilotConfigPath,
  loadTokenPilotCodexConfig,
  readCodexProviderFromToml,
  readCodexRootModelProvider,
  writeTokenPilotCodexConfig,
} from "./config.js";
import {
  defaultCodexSkillBridgeDir,
  installCommandSkillBridge,
} from "../../shared/command-skill-bridge.js";
import { migrateCodexThreadProviders } from "./thread-providers.js";

function quoteToml(value: string): string {
  return JSON.stringify(value);
}

function replaceOrInsertRootAssignment(text: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  let inRoot = true;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^\[.+\]$/.test(trimmed)) inRoot = false;
    if (!inRoot) break;
    if (new RegExp(`^${key}\\s*=`).test(trimmed)) {
      lines[i] = `${key} = ${value}`;
      return lines.join("\n");
    }
  }
  lines.unshift(`${key} = ${value}`);
  return lines.join("\n");
}

function upsertProviderSection(text: string, params: {
  providerName: string;
  baseUrl: string;
}): string {
  const sectionHeader = `[model_providers.${params.providerName}]`;
  const section = [
    sectionHeader,
    `name = ${quoteToml("TokenPilot")}`,
    `base_url = ${quoteToml(params.baseUrl)}`,
    `wire_api = ${quoteToml("responses")}`,
    "requires_openai_auth = true",
  ].join("\n");
  const sectionRe = new RegExp(`\\n?\\[model_providers\\.${params.providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*?(?=\\n\\[[^\\]]+\\]|$)`);
  if (sectionRe.test(text)) {
    return text.replace(sectionRe, `\n${section}\n`);
  }
  return `${text.replace(/\s*$/, "")}\n\n${section}\n`;
}

function upsertMcpServerSection(text: string, params: {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  startupTimeoutSec?: number;
}): string {
  const escape = (value: string) => JSON.stringify(value);
  const sectionHeader = `[mcp_servers.${params.serverName}]`;
  const lines = [
    sectionHeader,
    `command = ${escape(params.command)}`,
  ];
  if (params.args.length > 0) {
    lines.push(`args = [${params.args.map((value) => escape(value)).join(", ")}]`);
  }
  if (typeof params.startupTimeoutSec === "number" && Number.isFinite(params.startupTimeoutSec) && params.startupTimeoutSec > 0) {
    lines.push(`startup_timeout_sec = ${Math.trunc(params.startupTimeoutSec)}`);
  }
  const envEntries = Object.entries(params.env);
  if (envEntries.length > 0) {
    lines.push("", `[mcp_servers.${params.serverName}.env]`);
    for (const [key, value] of envEntries) {
      lines.push(`${key} = ${escape(value)}`);
    }
  }
  const section = lines.join("\n");
  const escapedServer = params.serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionFamilyRe = new RegExp(
    `\\n?\\[mcp_servers\\.${escapedServer}\\](?:[\\s\\S]*?(?=\\n\\[(?!mcp_servers\\.${escapedServer}(?:\\.|\\]))[^\\]]+\\]|$))?`
    + `(?:\\n\\[mcp_servers\\.${escapedServer}\\.[^\\]]+\\][\\s\\S]*?(?=\\n\\[(?!mcp_servers\\.${escapedServer}(?:\\.|\\]))[^\\]]+\\]|$))*`,
  );
  if (sectionFamilyRe.test(text)) {
    return text.replace(sectionFamilyRe, `\n${section}\n`);
  }
  return `${text.replace(/\s*$/, "")}\n\n${section}\n`;
}

function isCodexAdapterRoot(candidate: string): boolean {
  const packageJsonPath = join(candidate, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  if (!existsSync(join(candidate, "dist", "hooks-handler.js")) && !existsSync(join(candidate, "src", "hooks-handler.ts"))) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
    return parsed.name === "@tokenpilot/codex-adapter";
  } catch {
    return false;
  }
}

function adapterRootFromHere(moduleDir = __dirname): string {
  const fromDist = resolve(moduleDir, "..");
  if (isCodexAdapterRoot(fromDist)) {
    return fromDist;
  }
  const fromSrc = resolve(moduleDir, "..");
  if (isCodexAdapterRoot(fromSrc)) {
    return fromSrc;
  }
  let current = resolve(moduleDir, "..");
  for (let i = 0; i < 10; i += 1) {
    const nested = join(current, "components", "tokenpilot", "adapters", "codex");
    if (isCodexAdapterRoot(nested)) {
      return nested;
    }
    current = dirname(current);
  }
  current = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (isCodexAdapterRoot(current)) {
      return current;
    }
    const nested = join(current, "components", "tokenpilot", "adapters", "codex");
    if (isCodexAdapterRoot(nested)) return nested;
    current = dirname(current);
  }
  return join(process.cwd(), "components", "tokenpilot", "adapters", "codex");
}

function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function hookWrapperPath(adapterRoot: string): string {
  return join(adapterRoot, "dist", "tokenpilot-codex-hook.cmd");
}

function hookScriptPath(adapterRoot: string): string {
  return join(adapterRoot, "dist", "hooks-handler.js");
}

async function ensureWindowsHookWrapper(adapterRoot: string): Promise<string> {
  const wrapperPath = hookWrapperPath(adapterRoot);
  await mkdir(dirname(wrapperPath), { recursive: true });
  await writeFile(wrapperPath, [
    "@echo off",
    `${shellQuote(process.execPath)} ${shellQuote(hookScriptPath(adapterRoot))} %*`,
    "",
  ].join("\r\n"), "utf8");
  return wrapperPath;
}

async function tokenPilotHookCommand(adapterRoot: string, platform = process.platform): Promise<string> {
  if (platform === "win32") {
    return shellQuote(await ensureWindowsHookWrapper(adapterRoot));
  }
  return `${shellQuote(process.execPath)} ${shellQuote(hookScriptPath(adapterRoot))}`;
}

export async function resolveCodexHookCommandForInstall(
  platform = process.platform,
  moduleDir = __dirname,
): Promise<string> {
  return tokenPilotHookCommand(adapterRootFromHere(moduleDir), platform);
}

export function resolveCodexMcpServerSpecForInstall(stateDir: string): TokenPilotMcpServerSpec {
  return resolveTokenPilotMcpServerSpec({
    stateDir,
  });
}

export function resolveCodexMcpServerSpecForProbe(stateDir: string): TokenPilotMcpServerSpec {
  return resolveTokenPilotMcpProbeServerSpec({
    stateDir,
  });
}

function asHookConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function upsertTokenPilotHookGroup(groups: unknown, group: Record<string, unknown>): Record<string, unknown>[] {
  const list = Array.isArray(groups) ? groups.filter((item) => item && typeof item === "object") as Record<string, unknown>[] : [];
  const isTokenPilotGroup = (item: Record<string, unknown>): boolean => {
    const hooks = Array.isArray(item.hooks) ? item.hooks : [];
    return hooks.some((hook) => {
      if (!hook || typeof hook !== "object") return false;
      const command = (hook as Record<string, unknown>).command;
      return typeof command === "string"
        && (command.includes("hooks-handler.js") || command.includes("tokenpilot-codex-hook.cmd"));
    });
  };
  const filtered = list.filter((item) => !isTokenPilotGroup(item));
  return [...filtered, group];
}

async function installHooksJson(params: {
  hooksConfigPath: string;
  adapterRoot: string;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const existing = existsSync(params.hooksConfigPath)
    ? JSON.parse(await readFile(params.hooksConfigPath, "utf8"))
    : {};
  const root = asHookConfig(existing);
  const hooks = asHookConfig(root.hooks);
  const command = await tokenPilotHookCommand(params.adapterRoot, params.platform);
  const handler = (statusMessage: string, timeout = 30) => ({
    type: "command",
    command,
    statusMessage,
    timeout,
  });

  hooks.SessionStart = upsertTokenPilotHookGroup(hooks.SessionStart, {
    matcher: "startup|resume",
    hooks: [handler("Starting TokenPilot Codex proxy")],
  });
  hooks.PreToolUse = upsertTokenPilotHookGroup(hooks.PreToolUse, {
    matcher: ".*",
    hooks: [handler("Recording TokenPilot pre-tool metadata", 10)],
  });
  hooks.PostToolUse = upsertTokenPilotHookGroup(hooks.PostToolUse, {
    matcher: ".*",
    hooks: [handler("Recording TokenPilot tool output", 10)],
  });
  hooks.Stop = upsertTokenPilotHookGroup(hooks.Stop, {
    hooks: [handler("Recording TokenPilot session stop", 10)],
  });

  await mkdir(dirname(params.hooksConfigPath), { recursive: true });
  if (existsSync(params.hooksConfigPath)) {
    await copyFile(params.hooksConfigPath, `${params.hooksConfigPath}.tokenpilot.bak`);
  }
  await writeFile(params.hooksConfigPath, `${JSON.stringify({ ...root, hooks }, null, 2)}\n`, "utf8");
}

export async function installCodexTokenPilot(params?: {
  codexConfigPath?: string;
  tokenPilotConfigPath?: string;
  hooksConfigPath?: string;
  providerName?: string;
  installHooks?: boolean;
  probeMcp?: boolean;
  platform?: NodeJS.Platform;
}): Promise<{
  codexConfigPath: string;
  tokenPilotConfigPath: string;
  hooksConfigPath: string;
  providerName: string;
  activeProviderName: string;
  baseUrl: string;
  hooksInstalled: boolean;
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
  const codexConfigPath = params?.codexConfigPath ?? defaultCodexConfigPath();
  const tokenPilotConfigPath = params?.tokenPilotConfigPath ?? defaultTokenPilotConfigPath();
  const hooksConfigPath = params?.hooksConfigPath ?? defaultHooksConfigPath();
  const providerName = params?.providerName ?? "tokenpilot";
  const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
  const commandSkillsDir = defaultCodexSkillBridgeDir(dirname(codexConfigPath));
  const existingRootProvider = await readCodexRootModelProvider(codexConfigPath);
  const preferredActiveProvider = existingRootProvider && existingRootProvider !== providerName
    ? existingRootProvider
    : tokenPilotConfig.upstreamProvider;
  const activeProviderName = preferredActiveProvider && preferredActiveProvider !== providerName
    ? preferredActiveProvider
    : "OpenAI";
  const upstreamProvider = await readCodexProviderFromToml(activeProviderName, codexConfigPath);
  tokenPilotConfig.providerName = providerName;
  tokenPilotConfig.upstreamProvider = activeProviderName;
  if (upstreamProvider) {
    tokenPilotConfig.upstream = upstreamProvider;
  }
  await writeTokenPilotCodexConfig(tokenPilotConfig, tokenPilotConfigPath);
  const baseUrl = `http://127.0.0.1:${tokenPilotConfig.proxyPort}/v1`;
  const mcpServer = resolveCodexMcpServerSpecForInstall(tokenPilotConfig.stateDir);
  const mcpProbeServer = resolveCodexMcpServerSpecForProbe(tokenPilotConfig.stateDir);

  await mkdir(dirname(codexConfigPath), { recursive: true });
  const existing = existsSync(codexConfigPath) ? await readFile(codexConfigPath, "utf8") : "";
  if (existsSync(codexConfigPath)) {
    await copyFile(codexConfigPath, `${codexConfigPath}.tokenpilot.bak`);
  }
  let next = existing;
  next = upsertProviderSection(next, { providerName, baseUrl });
  next = upsertMcpServerSection(next, {
    serverName: mcpServer.serverName,
    command: mcpServer.command,
    args: mcpServer.args,
    env: mcpServer.env,
    startupTimeoutSec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
  });
  await writeFile(codexConfigPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  const hooksInstalled = params?.installHooks !== false;
  if (hooksInstalled) {
    await installHooksJson({
      hooksConfigPath,
      adapterRoot: adapterRootFromHere(),
      platform: params?.platform,
    });
  }
  migrateCodexThreadProviders({
    codexHome: dirname(codexConfigPath),
    activeProviderName,
  });
  const commandSkillBridge = await installCommandSkillBridge({
    adapterRoot: adapterRootFromHere(),
    skillsDir: commandSkillsDir,
    host: "codex",
    style: "codex",
  });
  const expectedHookCommand = await resolveCodexHookCommandForInstall(params?.platform);
  const mcpProbeResult = params?.probeMcp === false
    ? {
      ok: false,
      timedOut: false,
      degraded: true,
      detail: "MCP startup probe skipped by installer options",
    }
    : await probeTokenPilotMcpServer(mcpProbeServer, {
      timeoutMs: DEFAULT_TOKENPILOT_MCP_INSTALL_PROBE_TIMEOUT_MS,
      clientName: "tokenpilot-codex-install",
      clientVersion: "0.1.0",
    });
  return {
    codexConfigPath,
    tokenPilotConfigPath,
    hooksConfigPath,
    providerName,
    activeProviderName,
    baseUrl,
    hooksInstalled,
    mcpServerName: mcpServer.serverName,
    expectedHookCommand,
    expectedMcpCommand: mcpServer.command,
    expectedMcpArgs: mcpServer.args,
    expectedMcpStartupTimeoutSec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
    commandSkillsDir: commandSkillBridge.skillsDir,
    commandSkillNames: commandSkillBridge.skillNames,
    mcpProbe: {
      ...mcpProbeResult,
      degraded: !mcpProbeResult.ok,
    },
  };
}
