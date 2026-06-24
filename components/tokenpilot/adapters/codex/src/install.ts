import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  defaultCodexConfigPath,
  defaultHooksConfigPath,
  defaultTokenPilotConfigPath,
  loadTokenPilotCodexConfig,
  writeTokenPilotCodexConfig,
} from "./config.js";

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

function adapterRootFromHere(): string {
  const moduleDir = __dirname;
  const fromDist = resolve(moduleDir, "..");
  if (
    existsSync(join(fromDist, "package.json"))
    && existsSync(join(fromDist, "dist", "hooks-handler.js"))
  ) {
    return fromDist;
  }
  const fromSrc = resolve(moduleDir, "..");
  if (
    existsSync(join(fromSrc, "package.json"))
    && existsSync(join(fromSrc, "src"))
  ) {
    return fromSrc;
  }
  let current = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (
      existsSync(join(current, "package.json"))
      && existsSync(join(current, "src"))
      && existsSync(join(current, "scripts"))
    ) {
      return current;
    }
    const nested = join(current, "components", "tokenpilot", "adapters", "codex");
    if (existsSync(join(nested, "package.json"))) return nested;
    current = dirname(current);
  }
  return join(process.cwd(), "components", "tokenpilot", "adapters", "codex");
}

function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function tokenPilotHookCommand(adapterRoot: string): string {
  return `${shellQuote(process.execPath)} ${shellQuote(join(adapterRoot, "dist", "hooks-handler.js"))}`;
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
      return typeof command === "string" && command.includes("hooks-handler.js");
    });
  };
  const filtered = list.filter((item) => !isTokenPilotGroup(item));
  return [...filtered, group];
}

async function installHooksJson(params: {
  hooksConfigPath: string;
  adapterRoot: string;
}): Promise<void> {
  const existing = existsSync(params.hooksConfigPath)
    ? JSON.parse(await readFile(params.hooksConfigPath, "utf8"))
    : {};
  const root = asHookConfig(existing);
  const hooks = asHookConfig(root.hooks);
  const command = tokenPilotHookCommand(params.adapterRoot);
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
}): Promise<{
  codexConfigPath: string;
  tokenPilotConfigPath: string;
  hooksConfigPath: string;
  providerName: string;
  baseUrl: string;
  hooksInstalled: boolean;
}> {
  const codexConfigPath = params?.codexConfigPath ?? defaultCodexConfigPath();
  const tokenPilotConfigPath = params?.tokenPilotConfigPath ?? defaultTokenPilotConfigPath();
  const hooksConfigPath = params?.hooksConfigPath ?? defaultHooksConfigPath();
  const providerName = params?.providerName ?? "tokenpilot";
  const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
  tokenPilotConfig.providerName = providerName;
  await writeTokenPilotCodexConfig(tokenPilotConfig, tokenPilotConfigPath);
  const baseUrl = `http://127.0.0.1:${tokenPilotConfig.proxyPort}/v1`;

  await mkdir(dirname(codexConfigPath), { recursive: true });
  const existing = existsSync(codexConfigPath) ? await readFile(codexConfigPath, "utf8") : "";
  if (existsSync(codexConfigPath)) {
    await copyFile(codexConfigPath, `${codexConfigPath}.tokenpilot.bak`);
  }
  let next = replaceOrInsertRootAssignment(existing, "model_provider", quoteToml(providerName));
  next = upsertProviderSection(next, { providerName, baseUrl });
  await writeFile(codexConfigPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  const hooksInstalled = params?.installHooks !== false;
  if (hooksInstalled) {
    await installHooksJson({
      hooksConfigPath,
      adapterRoot: adapterRootFromHere(),
    });
  }
  return {
    codexConfigPath,
    tokenPilotConfigPath,
    hooksConfigPath,
    providerName,
    baseUrl,
    hooksInstalled,
  };
}
