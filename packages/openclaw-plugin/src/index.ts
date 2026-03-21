/* eslint-disable @typescript-eslint/no-explicit-any */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { readFile, mkdir, appendFile } from "node:fs/promises";
import { createOpenClawConnector } from "@ecoclaw/layer-orchestration";
import { createCacheModule, createSummaryModule, createCompressionModule } from "@ecoclaw/layer-execution";
import { createPolicyModule, createDecisionLedgerModule } from "@ecoclaw/layer-decision";
import { createMemoryStateModule } from "@ecoclaw/layer-data";
import { openaiAdapter } from "@ecoclaw/provider-openai";
import { anthropicAdapter } from "@ecoclaw/provider-anthropic";
import type { RuntimeTurnContext } from "@ecoclaw/kernel";

type EcoClawPluginConfig = {
  enabled?: boolean;
  logLevel?: "info" | "debug";
  proxyBaseUrl?: string;
  proxyApiKey?: string;
  runtimeMode?: "off" | "shadow";
  stateDir?: string;
  eventTracePath?: string;
  autoForkOnPolicy?: boolean;
  cacheTtlSeconds?: number;
  summaryTriggerInputTokens?: number;
  summaryTriggerStableChars?: number;
  summaryRecentTurns?: number;
  maxSummaryChars?: number;
  compactionPrompt?: string;
  resumePrefixPrompt?: string;
  cacheProbeEnabled?: boolean;
  cacheProbeIntervalSeconds?: number;
  cacheProbeMaxPromptChars?: number;
  cacheProbeHitMinTokens?: number;
  cacheProbeMissesToCold?: number;
  cacheProbeWarmSeconds?: number;
  debugTapProviderTraffic?: boolean;
  debugTapPath?: string;
};

type PluginLogger = {
  info?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type SessionTaskBinding = {
  taskId: string;
  sessionSeq: number;
};

type SessionTopologyManager = {
  getLogicalSessionId(sessionKey: string): string;
  getStatus(sessionKey: string): string;
  listTaskCaches(sessionKey: string): string;
  newTaskCache(sessionKey: string, taskId?: string): string;
  newSession(sessionKey: string): string;
  deleteTaskCache(sessionKey: string, taskId?: string): {
    removedTaskId: string;
    removedBindings: number;
    switchedToLogical: string;
  } | null;
};

function safeId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const norm = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return norm || "main";
}

function buildLogicalSessionId(taskId: string, sessionSeq: number): string {
  return `ecoclaw-task-${safeId(taskId)}-s${Math.max(1, sessionSeq)}`;
}

function createSessionTopologyManager(): SessionTopologyManager {
  const bindingBySessionKey = new Map<string, SessionTaskBinding>();
  const countersByTaskId = new Map<string, number>();
  let globalDefaultTaskId: string | null = null;

  function scopedFamilyPrefix(sessionKey: string): string | null {
    const key = (sessionKey || "").trim();
    if (!key.startsWith("scoped:")) return null;
    const parts = key.split(":");
    if (parts.length < 3) return null;
    return `${parts[0]}:${parts[1]}:${parts[2]}`;
  }

  function ensure(sessionKey: string, preferredTaskId?: string): SessionTaskBinding {
    const key = sessionKey || "unknown";
    const existing = bindingBySessionKey.get(key);
    if (existing) return existing;
    const defaultTaskId = safeId(preferredTaskId ?? globalDefaultTaskId ?? `default-${safeId(key)}`);
    const initialSeq = 1;
    const init: SessionTaskBinding = { taskId: defaultTaskId, sessionSeq: initialSeq };
    bindingBySessionKey.set(key, init);
    countersByTaskId.set(defaultTaskId, Math.max(countersByTaskId.get(defaultTaskId) ?? 0, initialSeq));
    return init;
  }

  return {
    getLogicalSessionId(sessionKey: string): string {
      const b = ensure(sessionKey);
      return buildLogicalSessionId(b.taskId, b.sessionSeq);
    },
    getStatus(sessionKey: string): string {
      const b = ensure(sessionKey);
      return `sessionKey=${sessionKey} task=${b.taskId} logical=${buildLogicalSessionId(b.taskId, b.sessionSeq)} seq=${b.sessionSeq}`;
    },
    listTaskCaches(sessionKey: string): string {
      const current = ensure(sessionKey);
      const taskIds = new Set<string>();
      for (const binding of bindingBySessionKey.values()) taskIds.add(binding.taskId);
      for (const taskId of countersByTaskId.keys()) taskIds.add(taskId);
      const sorted = Array.from(taskIds).sort((a, b) => a.localeCompare(b));
      if (sorted.length === 0) {
        return `No task-cache found.\n${this.getStatus(sessionKey)}`;
      }
      const lines = ["Task-caches:"];
      for (const taskId of sorted) {
        const seqMax = Math.max(1, countersByTaskId.get(taskId) ?? 1);
        const activeBindings = Array.from(bindingBySessionKey.values()).filter((b) => b.taskId === taskId).length;
        const mark = taskId === current.taskId ? "*" : " ";
        lines.push(`${mark} ${taskId} (sessions<=${seqMax}, bindings=${activeBindings})`);
      }
      lines.push("", `current: ${current.taskId} -> ${buildLogicalSessionId(current.taskId, current.sessionSeq)}`);
      return lines.join("\n");
    },
    newTaskCache(sessionKey: string, taskId?: string): string {
      const chosenTaskId = safeId(taskId ?? `task-${Date.now()}`);
      const seq = 1;
      countersByTaskId.set(chosenTaskId, Math.max(countersByTaskId.get(chosenTaskId) ?? 0, seq));
      globalDefaultTaskId = chosenTaskId;
      bindingBySessionKey.set(sessionKey, { taskId: chosenTaskId, sessionSeq: seq });
      const family = scopedFamilyPrefix(sessionKey);
      if (family) {
        for (const [key] of bindingBySessionKey.entries()) {
          if (key === sessionKey) continue;
          if (key === family || key.startsWith(`${family}:`)) {
            bindingBySessionKey.set(key, { taskId: chosenTaskId, sessionSeq: seq });
          }
        }
      }
      return buildLogicalSessionId(chosenTaskId, seq);
    },
    newSession(sessionKey: string): string {
      const current = ensure(sessionKey);
      const next = (countersByTaskId.get(current.taskId) ?? current.sessionSeq) + 1;
      countersByTaskId.set(current.taskId, next);
      const updated: SessionTaskBinding = { taskId: current.taskId, sessionSeq: next };
      bindingBySessionKey.set(sessionKey, updated);
      const family = scopedFamilyPrefix(sessionKey);
      if (family) {
        for (const [key, binding] of bindingBySessionKey.entries()) {
          if (key === sessionKey) continue;
          if (binding.taskId !== current.taskId) continue;
          if (key === family || key.startsWith(`${family}:`)) {
            bindingBySessionKey.set(key, { taskId: current.taskId, sessionSeq: next });
          }
        }
      }
      return buildLogicalSessionId(updated.taskId, updated.sessionSeq);
    },
    deleteTaskCache(sessionKey: string, taskId?: string) {
      const current = ensure(sessionKey);
      const targetTaskId = safeId(taskId ?? current.taskId);
      let removedBindings = 0;
      for (const [key, binding] of bindingBySessionKey.entries()) {
        if (binding.taskId === targetTaskId) {
          bindingBySessionKey.delete(key);
          removedBindings += 1;
        }
      }
      countersByTaskId.delete(targetTaskId);
      if (globalDefaultTaskId === targetTaskId) {
        globalDefaultTaskId = null;
      }
      if (removedBindings === 0) return null;
      const baseDefaultTaskId = `default-${safeId(sessionKey || "unknown")}`;
      const fallbackTaskId =
        targetTaskId === baseDefaultTaskId
          ? `${baseDefaultTaskId}-r${Date.now().toString(36)}`
          : baseDefaultTaskId;
      const fallback = ensure(sessionKey, fallbackTaskId);
      return {
        removedTaskId: targetTaskId,
        removedBindings,
        switchedToLogical: buildLogicalSessionId(fallback.taskId, fallback.sessionSeq),
      };
    },
  };
}

type EcoClawCmd = {
  kind: "none" | "status" | "cache_new" | "cache_delete" | "cache_list" | "session_new" | "help";
  taskId?: string;
};

function parseEcoClawCommand(raw: string): EcoClawCmd {
  const text = raw.trim();
  if (!text) return { kind: "none" };
  const normalized = text.startsWith("/") ? text.slice(1).trim() : text;
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "none" };
  if (parts[0].toLowerCase() !== "ecoclaw") return { kind: "none" };
  if (parts.length === 1) return { kind: "help" };

  const scope = parts[1]?.toLowerCase();
  if (scope === "help" || scope === "h" || scope === "--help") return { kind: "help" };
  const action = parts[2]?.toLowerCase();
  if (scope === "status") return { kind: "status" };
  if (scope === "cache" && action === "new") {
    return { kind: "cache_new", taskId: parts[3] };
  }
  if (scope === "cache" && (action === "list" || action === "ls")) {
    return { kind: "cache_list" };
  }
  if (scope === "cache" && (action === "delete" || action === "del" || action === "rm")) {
    return { kind: "cache_delete", taskId: parts[3] };
  }
  if (scope === "session" && action === "new") {
    return { kind: "session_new" };
  }
  return { kind: "help" };
}

function commandHelpText(): string {
  return [
    "EcoClaw commands:",
    "  /ecoclaw help",
    "    作用: 显示这份帮助与示例。",
    "  /ecoclaw status",
    "    作用: 查看当前会话绑定到哪个 task-cache / logical session。",
    "  /ecoclaw cache new [task-id]",
    "    作用: 新建并切换到一个 task-cache（工作区）。",
    "  /ecoclaw cache list",
    "    作用: 列出当前所有 task-cache，并标记当前所在工作区。",
    "  /ecoclaw cache delete [task-id]",
    "    作用: 删除指定（或当前）task-cache，并回退到默认绑定。",
    "  /ecoclaw session new",
    "    作用: 在当前 task-cache 内开启下一条 logical session 分支。",
    "",
    "示例:",
    "  /ecoclaw cache new demo-task",
    "  /ecoclaw cache list",
    "  /ecoclaw session new",
    "  /ecoclaw status",
    "",
    "说明:",
    "  - 请在 TUI 里优先使用 slash 命令: /ecoclaw ...",
    "  - 1 个 task-cache 可以包含多个 session。",
  ].join("\n");
}

function normalizeConfig(raw: unknown): Required<Omit<EcoClawPluginConfig, "proxyBaseUrl" | "proxyApiKey">> &
  Pick<EcoClawPluginConfig, "proxyBaseUrl" | "proxyApiKey"> {
  const cfg = (raw ?? {}) as EcoClawPluginConfig;
  const defaultStateDir = join(homedir(), ".openclaw", "ecoclaw-plugin-state");
  const stateDir = cfg.stateDir ?? defaultStateDir;
  return {
    enabled: cfg.enabled ?? true,
    logLevel: cfg.logLevel ?? "info",
    proxyBaseUrl: cfg.proxyBaseUrl,
    proxyApiKey: cfg.proxyApiKey,
    runtimeMode: cfg.runtimeMode ?? "shadow",
    stateDir,
    eventTracePath: cfg.eventTracePath ?? join(stateDir, "ecoclaw", "event-trace.jsonl"),
    autoForkOnPolicy: cfg.autoForkOnPolicy ?? true,
    cacheTtlSeconds: Math.max(60, cfg.cacheTtlSeconds ?? 600),
    summaryTriggerInputTokens: Math.max(0, cfg.summaryTriggerInputTokens ?? 200000),
    summaryTriggerStableChars: Math.max(0, cfg.summaryTriggerStableChars ?? 0),
    summaryRecentTurns: Math.max(1, cfg.summaryRecentTurns ?? 8),
    maxSummaryChars: Math.max(200, cfg.maxSummaryChars ?? 6000),
    compactionPrompt: cfg.compactionPrompt ?? "",
    resumePrefixPrompt: cfg.resumePrefixPrompt ?? "",
    cacheProbeEnabled: cfg.cacheProbeEnabled ?? true,
    cacheProbeIntervalSeconds: Math.max(30, cfg.cacheProbeIntervalSeconds ?? 1800),
    cacheProbeMaxPromptChars: Math.max(1, cfg.cacheProbeMaxPromptChars ?? 120),
    cacheProbeHitMinTokens: Math.max(0, cfg.cacheProbeHitMinTokens ?? 64),
    cacheProbeMissesToCold: Math.max(1, cfg.cacheProbeMissesToCold ?? 2),
    cacheProbeWarmSeconds: Math.max(30, cfg.cacheProbeWarmSeconds ?? 7200),
    debugTapProviderTraffic: cfg.debugTapProviderTraffic ?? false,
    debugTapPath: cfg.debugTapPath ?? join(stateDir, "ecoclaw", "provider-traffic.jsonl"),
  };
}

function maybeInstallProviderTrafficTap(
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
): void {
  if (!cfg.debugTapProviderTraffic) return;
  const g = globalThis as any;
  if (g.__ecoclaw_provider_tap_installed__) return;
  const origFetch = g.fetch;
  if (typeof origFetch !== "function") {
    logger.warn("[ecoclaw] debugTapProviderTraffic requested but global fetch is unavailable.");
    return;
  }
  g.__ecoclaw_provider_tap_installed__ = true;
  g.fetch = async (input: any, init?: any) => {
    let url = "";
    try {
      url =
        typeof input === "string"
          ? input
          : typeof input?.url === "string"
            ? input.url
            : "";
    } catch {
      url = "";
    }
    const lower = url.toLowerCase();
    const isProviderCall =
      lower.includes("api.openai.com") ||
      lower.includes("api.anthropic.com") ||
      lower.includes("dashscope") ||
      lower.includes("openrouter.ai");

    let reqBody = "";
    if (isProviderCall) {
      try {
        if (typeof init?.body === "string") {
          reqBody = init.body;
        } else if (input && typeof input.clone === "function") {
          const clone = input.clone();
          reqBody = await clone.text();
        }
      } catch {
        reqBody = "";
      }
    }

    const startedAt = new Date().toISOString();
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    const res = await origFetch(input, init);

    if (isProviderCall) {
      void (async () => {
        try {
          const clone = res.clone();
          const txt = await clone.text();
          let parsed: any = undefined;
          try {
            parsed = JSON.parse(txt);
          } catch {
            parsed = undefined;
          }
          const usage =
            parsed?.usage ??
            parsed?.response?.usage ??
            parsed?.data?.usage ??
            undefined;
          const rec = {
            at: startedAt,
            method,
            url,
            status: Number((res as any)?.status ?? 0),
            requestBody: reqBody || undefined,
            responseUsage: usage || undefined,
            responseBody: parsed ?? (txt ? txt.slice(0, 4000) : undefined),
          };
          const p = cfg.debugTapPath;
          await mkdir(dirname(p), { recursive: true });
          await appendFile(p, `${JSON.stringify(rec)}\n`, "utf8");
        } catch (err) {
          logger.warn(
            `[ecoclaw] provider tap write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }
    return res;
  };
  logger.info(`[ecoclaw] Provider traffic tap enabled. path=${cfg.debugTapPath}`);
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = toJsonSafe(v, seen);
    }
    seen.delete(obj);
    return out;
  }
  return String(value);
}

async function appendJsonl(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(toJsonSafe(payload))}\n`, "utf8");
}

function resolveLlmHookTapPath(debugTapPath: string): string {
  if (debugTapPath.endsWith(".jsonl")) {
    return debugTapPath.slice(0, -".jsonl".length) + ".llm-hooks.jsonl";
  }
  return `${debugTapPath}.llm-hooks.jsonl`;
}

function installLlmHookTap(
  api: any,
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
): void {
  if (!cfg.debugTapProviderTraffic) return;
  const llmHookTapPath = resolveLlmHookTapPath(cfg.debugTapPath);
  const hookNames = [
    "before_prompt_build",
    "before_agent_start",
    "llm_input",
    "llm_output",
    "agent_end",
  ];
  for (const hookName of hookNames) {
    hookOn(api, hookName, async (event: any) => {
      try {
        const rec = {
          at: new Date().toISOString(),
          hook: hookName,
          sessionKey: extractSessionKey(event),
          event,
        };
        await appendJsonl(llmHookTapPath, rec);
      } catch (err) {
        logger.warn(
          `[ecoclaw] llm-hook tap write failed(${hookName}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
  logger.info(`[ecoclaw] LLM hook tap enabled. path=${llmHookTapPath}`);
}

async function purgeTaskCacheWorkspace(stateDir: string, taskId: string): Promise<{ purged: string[] }> {
  const sessionsDir = join(stateDir, "ecoclaw", "sessions");
  const targetPrefix = `ecoclaw-task-${safeId(taskId)}-s`;
  let entries: Array<{ isDirectory: () => boolean; name: string }>;
  try {
    entries = (await readdir(sessionsDir, { withFileTypes: true, encoding: "utf8" })) as Array<{
      isDirectory: () => boolean;
      name: string;
    }>;
  } catch {
    return { purged: [] };
  }

  const purged: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(targetPrefix)) continue;
    const fullPath = join(sessionsDir, entry.name);
    await rm(fullPath, { recursive: true, force: true });
    purged.push(fullPath);
  }
  return { purged };
}

function makeLogger(input?: PluginLogger): Required<PluginLogger> {
  return {
    info: input?.info ?? ((...args) => console.log(...args)),
    debug: input?.debug ?? (() => {}),
    warn: input?.warn ?? ((...args) => console.warn(...args)),
    error: input?.error ?? ((...args) => console.error(...args)),
  };
}

function hookOn(api: any, event: string, handler: (...args: any[]) => any): void {
  if (typeof api.on === "function") {
    api.on(event, handler);
    return;
  }
  if (typeof api.registerHook === "function") {
    api.registerHook(event, handler);
  }
}

function maybeRegisterProxyProvider(api: any, cfg: ReturnType<typeof normalizeConfig>, logger: Required<PluginLogger>) {
  if (!cfg.proxyBaseUrl) return;
  if (typeof api.registerProvider !== "function") {
    logger.warn("[ecoclaw] registerProvider not supported by this OpenClaw version.");
    return;
  }

  try {
    api.registerProvider({
      id: "ecoclaw",
      name: "EcoClaw Router",
      label: "EcoClaw Router",
      api: "openai-completions",
      baseUrl: cfg.proxyBaseUrl,
      apiKey: cfg.proxyApiKey,
      models: ["auto"],
    });
    logger.info("[ecoclaw] Registered provider ecoclaw/auto via proxyBaseUrl.");
  } catch (err: unknown) {
    logger.error(`[ecoclaw] Failed to register provider: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function extractSessionKey(event: any): string {
  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta;
  const direct =
    event?.sessionKey ??
    event?.result?.sessionKey ??
    event?.meta?.sessionKey ??
    event?.ctx?.SessionKey ??
    event?.session?.key ??
    event?.sessionId ??
    event?.result?.sessionId ??
    agentMeta?.sessionKey ??
    agentMeta?.sessionId ??
    "";
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();

  const channel = String(event?.channel ?? event?.from?.channel ?? "unknown").trim();
  const channelId = String(event?.channelId ?? event?.to?.id ?? event?.conversationId ?? "").trim();
  const threadId = String(event?.messageThreadId ?? event?.threadId ?? "").trim();
  const senderId = String(event?.senderId ?? event?.from?.id ?? "").trim();
  const scoped = [channel, channelId, threadId, senderId].filter((x) => x.length > 0);
  if (scoped.length > 0) return `scoped:${scoped.join(":")}`;

  return "unknown";
}

function contentToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => contentToText(item))
      .filter((s) => s.trim().length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "thinking" || obj.type === "reasoning") {
      return "";
    }
    if (obj.type === "output_text" && typeof obj.text === "string") {
      return obj.text;
    }
    const preferred = obj.text ?? obj.content ?? obj.value ?? obj.message;
    if (preferred !== undefined) {
      const nested = contentToText(preferred);
      if (nested.trim().length > 0) return nested;
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return String(obj);
    }
  }
  return String(value);
}

function extractLastUserMessage(event: any): string {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m?.role === "user");
  return contentToText(lastUser?.content ?? event?.message?.content ?? event?.message ?? "");
}

function extractLastAssistant(event: any): any {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const fromMessages = [...messages].reverse().find((m: any) => m?.role === "assistant");
  if (fromMessages) return fromMessages;

  const payloads = Array.isArray(event?.result?.payloads) ? event.result.payloads : [];
  if (payloads.length === 0) return null;
  const payloadText = payloads
    .map((payload: any) => contentToText(payload?.text ?? payload?.content ?? payload))
    .filter((s: string) => s.trim().length > 0)
    .join("\n");
  const lastPayload = payloads[payloads.length - 1];

  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta ?? {};
  const usage = agentMeta?.lastCallUsage ?? agentMeta?.usage ?? event?.usage ?? {};
  return {
    role: "assistant",
    content: payloadText || contentToText(lastPayload?.text ?? lastPayload?.content ?? ""),
    provider: agentMeta?.provider ?? event?.provider,
    model: agentMeta?.model ?? event?.model,
    usage,
  };
}

async function buildPromptRootFromSystemPromptReport(report: any): Promise<string> {
  if (!report || typeof report !== "object") return "";
  const files = Array.isArray(report.injectedWorkspaceFiles) ? report.injectedWorkspaceFiles : [];
  const header: string[] = [
    "# OpenClaw Root Prompt (reconstructed)",
    `provider/model: ${String(report.provider ?? "-")}/${String(report.model ?? "-")}`,
    `workspace: ${String(report.workspaceDir ?? "-")}`,
    "",
    "## Context Weight (from systemPromptReport)",
    `- total chars: ${String(report.systemPrompt?.chars ?? "-")}`,
    `- project-context chars: ${String(report.systemPrompt?.projectContextChars ?? "-")}`,
    `- non-project chars: ${String(report.systemPrompt?.nonProjectContextChars ?? "-")}`,
    "",
    "## Skills Snapshot",
  ];
  const skillEntries = Array.isArray(report.skills?.entries) ? report.skills.entries : [];
  if (skillEntries.length === 0) {
    header.push("- (none)");
  } else {
    for (const s of skillEntries) {
      header.push(`- ${String(s?.name ?? "(unknown)")} (${String(s?.blockChars ?? 0)} chars)`);
    }
  }
  header.push("", "## Tools Snapshot");
  const toolEntries = Array.isArray(report.tools?.entries) ? report.tools.entries : [];
  if (toolEntries.length === 0) {
    header.push("- (none)");
  } else {
    for (const t of toolEntries) {
      header.push(`- ${String(t?.name ?? "(unknown)")} (summary=${String(t?.summaryChars ?? 0)}, schema=${String(t?.schemaChars ?? 0)})`);
    }
  }
  header.push("", "## Project Context");
  const blocks: string[] = [];
  for (const file of files) {
    const name = String(file?.name ?? "UNKNOWN");
    const path = String(file?.path ?? "");
    const missing = Boolean(file?.missing);
    if (!path || missing) {
      blocks.push(`[${name}] (missing)`);
      continue;
    }
    try {
      const content = await readFile(path, "utf8");
      blocks.push(`[${name}]\n${content}`);
    } catch {
      blocks.push(`[${name}] (read-failed: ${path})`);
    }
  }
  return [...header, ...blocks].join("\n\n");
}

async function extractOpenClawPromptRoot(event: any): Promise<string> {
  const msgs = Array.isArray(event?.messages) ? event.messages : [];
  const systemTexts = msgs
    .filter((m: any) => String(m?.role ?? "").toLowerCase() === "system")
    .map((m: any) => contentToText(m?.content))
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);
  if (systemTexts.length > 0) {
    return systemTexts.join("\n\n");
  }

  const report =
    event?.result?.meta?.systemPromptReport ??
    event?.meta?.systemPromptReport ??
    event?.systemPromptReport;
  const fromReport = await buildPromptRootFromSystemPromptReport(report);
  if (fromReport) return fromReport;

  // Last fallback: reconstruct from default OpenClaw workspace files.
  const workspaceFiles = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md"];
  const blocks: string[] = ["# OpenClaw Root Prompt (fallback workspace reconstruction)"];
  for (const name of workspaceFiles) {
    const path = join(homedir(), ".openclaw", "workspace", name);
    try {
      const text = await readFile(path, "utf8");
      blocks.push(`[${name}]\n${text}`);
    } catch {
      blocks.push(`[${name}] (missing)`);
    }
  }
  return blocks.join("\n\n");
}

function extractTurnTools(event: any): string[] {
  const msgs = Array.isArray(event?.messages) ? event.messages : [];
  const out: string[] = [];
  for (const m of msgs) {
    const role = String(m?.role ?? "").toLowerCase();
    if (role !== "tool") continue;
    const text = contentToText(m?.content ?? m?.text ?? "").trim();
    if (text) out.push(text);
  }
  return out;
}

function buildProviderRawFromAssistant(assistant: any): Record<string, unknown> {
  const usage = (assistant?.usage ?? {}) as Record<string, unknown>;
  const inputRaw = usage.input_tokens ?? usage.input ?? usage.prompt_tokens ?? usage.promptTokens;
  const outputRaw = usage.output_tokens ?? usage.output ?? usage.completion_tokens ?? usage.completionTokens;
  const cacheReadRaw =
    usage.cacheRead ??
      usage.cache_read_tokens ??
      usage.cache_read_input_tokens ??
      (usage.prompt_tokens_details as any)?.cached_tokens;
  const input = Number(inputRaw);
  const output = Number(outputRaw);
  const cacheRead = Number(cacheReadRaw);
  const promptDetails: Record<string, unknown> = {};
  if (Number.isFinite(cacheRead)) promptDetails.cached_tokens = cacheRead;
  const out: Record<string, unknown> = {};
  if (Number.isFinite(input)) out.input_tokens = input;
  if (Number.isFinite(output)) out.output_tokens = output;
  if (Object.keys(promptDetails).length > 0) out.prompt_tokens_details = promptDetails;
  return out;
}

function buildProviderRawFromEvent(event: any, assistant: any): Record<string, unknown> {
  const fromAssistant = buildProviderRawFromAssistant(assistant);
  const hasAssistantUsage =
    Number(fromAssistant.input_tokens ?? 0) > 0 ||
    Number(fromAssistant.output_tokens ?? 0) > 0 ||
    Number((fromAssistant.prompt_tokens_details as any)?.cached_tokens ?? 0) > 0;
  if (hasAssistantUsage) return fromAssistant;

  const usage =
    event?.result?.meta?.agentMeta?.lastCallUsage ??
    event?.meta?.agentMeta?.lastCallUsage ??
    event?.agentMeta?.lastCallUsage ??
    event?.usage ??
    {};
  const input = Number(
    usage.input_tokens ??
      usage.inputTokens ??
      usage.input ??
      usage.prompt_tokens ??
      usage.promptTokens,
  );
  const output = Number(
    usage.output_tokens ??
      usage.outputTokens ??
      usage.output ??
      usage.completion_tokens ??
      usage.completionTokens,
  );
  const cacheRead = Number(
    usage.cacheRead ??
      usage.cache_read_tokens ??
      usage.cache_read_input_tokens ??
      usage.cached_input_tokens ??
      usage.cachedTokens ??
      usage.cacheHitTokens ??
      (usage.prompt_tokens_details as any)?.cached_tokens,
  );
  const cacheWrite = Number(
    usage.cacheWrite ??
      usage.cache_write_tokens ??
      usage.cache_write_input_tokens,
  );
  const promptDetails: Record<string, unknown> = {};
  if (Number.isFinite(cacheRead)) promptDetails.cached_tokens = cacheRead;
  if (Number.isFinite(cacheWrite)) promptDetails.cache_write_tokens = cacheWrite;
  const out: Record<string, unknown> = {};
  if (Number.isFinite(input)) out.input_tokens = input;
  if (Number.isFinite(output)) out.output_tokens = output;
  if (Object.keys(promptDetails).length > 0) out.prompt_tokens_details = promptDetails;
  return out;
}

function extractModelApi(event: any): string | undefined {
  const api =
    event?.result?.meta?.agentMeta?.api ??
    event?.meta?.agentMeta?.api ??
    event?.agentMeta?.api ??
    event?.modelApi ??
    event?.api;
  return typeof api === "string" && api.trim() ? api.trim() : undefined;
}

function registerEcoClawCommand(
  api: any,
  logger: Required<PluginLogger>,
  topology: SessionTopologyManager,
  cfg: ReturnType<typeof normalizeConfig>,
): void {
  if (typeof api.registerCommand !== "function") {
    logger.debug("[ecoclaw] registerCommand unavailable, fallback to inline command parsing.");
    return;
  }

  const handler = async (ctxOrRaw?: any, legacyContext?: any) => {
    const args =
      typeof ctxOrRaw === "string"
        ? ctxOrRaw
        : typeof ctxOrRaw?.args === "string"
          ? ctxOrRaw.args
          : "";
    const context = legacyContext ?? ctxOrRaw ?? {};
    const cmd = parseEcoClawCommand(`ecoclaw ${String(args).trim()}`.trim());
    const sessionKey = extractSessionKey(context) || "unknown";
    logger.info(
      `[ecoclaw] command invoked kind=${cmd.kind} args="${String(args ?? "").trim()}" session=${sessionKey}`,
    );
    if (cmd.kind === "status") {
      return { text: topology.getStatus(sessionKey) };
    }
    if (cmd.kind === "cache_new") {
      const logical = topology.newTaskCache(sessionKey, cmd.taskId);
      return {
        text:
          `Created task-cache and switched current binding.\n${topology.getStatus(sessionKey)}\nlogical=${logical}\n\n` +
          `Reminder: this switches EcoClaw task-cache only.\n` +
          `If you want a truly clean upstream OpenClaw context, run /new now.`,
      };
    }
    if (cmd.kind === "cache_list") {
      return { text: topology.listTaskCaches(sessionKey) };
    }
    if (cmd.kind === "cache_delete") {
      const removed = topology.deleteTaskCache(sessionKey, cmd.taskId);
      if (!removed) {
        return { text: `No matching task-cache found for ${cmd.taskId ? `"${safeId(cmd.taskId)}"` : "current binding"}.` };
      }
      const purge = await purgeTaskCacheWorkspace(cfg.stateDir, removed.removedTaskId);
      return {
        text: `Deleted task-cache "${removed.removedTaskId}" (bindings=${removed.removedBindings}, purged=${purge.purged.length}).\n${topology.getStatus(sessionKey)}\nlogical=${removed.switchedToLogical}`,
      };
    }
    if (cmd.kind === "session_new") {
      const logical = topology.newSession(sessionKey);
      return { text: `Created new session in current task-cache.\n${topology.getStatus(sessionKey)}\nlogical=${logical}` };
    }
    return { text: commandHelpText() };
  };

  api.registerCommand({
    name: "ecoclaw",
    description: "EcoClaw task-cache/session controls (try: /ecoclaw help)",
    acceptsArgs: true,
    handler,
    execute: handler,
  });
  logger.debug("[ecoclaw] Registered /ecoclaw command.");
}

module.exports = {
  id: "ecoclaw",
  name: "EcoClaw Runtime Optimizer",

  register(api: any) {
    const logger = makeLogger(api?.logger);
    const cfg = normalizeConfig(api?.pluginConfig);
    const debugEnabled = cfg.logLevel === "debug";

    if (!cfg.enabled) {
      logger.info("[ecoclaw] Plugin disabled by config.");
      return;
    }

    maybeRegisterProxyProvider(api, cfg, logger);
    maybeInstallProviderTrafficTap(cfg, logger);
    installLlmHookTap(api, cfg, logger);
    const topology = createSessionTopologyManager();
    registerEcoClawCommand(api, logger, topology, cfg);
    const shadowConnector =
      cfg.runtimeMode === "shadow"
        ? createOpenClawConnector({
            modules: [
              createCacheModule({ minPrefixChars: 32, tree: { ttlSeconds: cfg.cacheTtlSeconds } }),
              createPolicyModule({
                summaryTriggerInputTokens: cfg.summaryTriggerInputTokens,
                summaryTriggerStableChars: cfg.summaryTriggerStableChars,
                cacheProbeEnabled: cfg.cacheProbeEnabled,
                cacheProbeIntervalSeconds: cfg.cacheProbeIntervalSeconds,
                cacheProbeMaxPromptChars: cfg.cacheProbeMaxPromptChars,
                cacheProbeHitMinTokens: cfg.cacheProbeHitMinTokens,
                cacheProbeMissesToCold: cfg.cacheProbeMissesToCold,
                cacheProbeWarmSeconds: cfg.cacheProbeWarmSeconds,
              }),
              createDecisionLedgerModule(),
              createMemoryStateModule({ maxSummaryChars: cfg.maxSummaryChars }),
              createSummaryModule({
                idleTriggerMinutes: 50,
                recentTurns: cfg.summaryRecentTurns,
                compactionPrompt: cfg.compactionPrompt,
                resumePrefixPrompt: cfg.resumePrefixPrompt,
              }),
              createCompressionModule({ maxToolChars: 1200 }),
            ],
            adapters: {
              openai: openaiAdapter,
              anthropic: anthropicAdapter,
            },
            stateDir: cfg.stateDir,
            routing: {
              autoForkOnPolicy: cfg.autoForkOnPolicy,
              physicalSessionPrefix: "phy",
            },
            observability: {
              eventTracePath: cfg.eventTracePath,
            },
          })
        : null;

    hookOn(api, "message_received", (event: any) => {
      const sessionKey = extractSessionKey(event);
      const userMessage = extractLastUserMessage(event);
      const cmd = parseEcoClawCommand(userMessage);
      if (cmd.kind !== "none") {
        if (cmd.kind === "status") {
          logger.info(`[ecoclaw] ${topology.getStatus(sessionKey)}`);
        } else if (cmd.kind === "cache_new") {
          const logical = topology.newTaskCache(sessionKey, cmd.taskId);
          logger.info(`[ecoclaw] cache new -> ${topology.getStatus(sessionKey)} logical=${logical}`);
        } else if (cmd.kind === "cache_delete") {
          const removed = topology.deleteTaskCache(sessionKey, cmd.taskId);
          if (!removed) {
            logger.info(
              `[ecoclaw] cache delete -> no matching task-cache for ${cmd.taskId ? safeId(cmd.taskId) : "current"}`,
            );
          } else {
            void purgeTaskCacheWorkspace(cfg.stateDir, removed.removedTaskId)
              .then((purge) => {
                logger.info(
                  `[ecoclaw] cache delete -> removed=${removed.removedTaskId} bindings=${removed.removedBindings} purged=${purge.purged.length} now=${topology.getStatus(sessionKey)} logical=${removed.switchedToLogical}`,
                );
              })
              .catch((err) => {
                logger.warn(
                  `[ecoclaw] cache delete purge failed for ${removed.removedTaskId}: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
          }
        } else if (cmd.kind === "session_new") {
          const logical = topology.newSession(sessionKey);
          logger.info(`[ecoclaw] session new -> ${topology.getStatus(sessionKey)} logical=${logical}`);
        } else {
          logger.info(`[ecoclaw] ${commandHelpText().replace(/\n/g, " | ")}`);
        }
      }
      if (!debugEnabled) return;
      logger.debug(`[ecoclaw] message_received session=${sessionKey}`);
    });

    hookOn(api, "agent_end", async (event: any) => {
      const sessionKey = extractSessionKey(event);
      const lastAssistant = extractLastAssistant(event);
      const model = lastAssistant?.model ?? event?.model ?? "unknown";
      const provider = lastAssistant?.provider ?? event?.provider ?? "unknown";
      if (debugEnabled) {
        logger.debug(`[ecoclaw] agent_end session=${sessionKey} provider=${provider} model=${model}`);
      }
      if (!shadowConnector) return;
      const logicalSessionId = topology.getLogicalSessionId(sessionKey);
      const userMessage = extractLastUserMessage(event) || "[empty-user-message]";
      const inlineCmd = parseEcoClawCommand(userMessage);
      if (inlineCmd.kind !== "none") {
        if (debugEnabled) {
          logger.debug(`[ecoclaw] skip shadow runtime for command message session=${sessionKey}`);
        }
        return;
      }
      const assistantContent = contentToText(lastAssistant?.content ?? "");
      const openClawPromptRoot = await extractOpenClawPromptRoot(event);
      const turnTools = extractTurnTools(event);
      const providerId = String(provider || "openai").toLowerCase();
      const runtimeProvider = providerId.includes("anthropic") ? "anthropic" : "openai";
      const runtimeModel = String(model || (runtimeProvider === "anthropic" ? "claude-sonnet-4" : "gpt-5"));
      const modelApi = extractModelApi(event);

      const turnCtx: RuntimeTurnContext = {
        sessionId: logicalSessionId,
        sessionMode: "cross",
        provider: runtimeProvider,
        model: runtimeModel,
        prompt: userMessage,
        segments: [
          {
            id: "stable-system",
            kind: "stable",
            text: "SYSTEM_STABLE: Keep assistant behavior consistent and compact.",
            priority: 1,
          },
          {
            id: "volatile-user",
            kind: "volatile",
            text: userMessage,
            priority: 10,
          },
        ],
        budget: {
          maxInputTokens: 12000,
          reserveOutputTokens: 1200,
        },
        metadata: {
          logicalSessionId,
          source: "openclaw-plugin-shadow",
          modelApi: modelApi ?? undefined,
          openclawPromptRoot: openClawPromptRoot || undefined,
          turnTools: turnTools.length > 0 ? turnTools : undefined,
        },
      };

      try {
        const shadowResult = await shadowConnector.onLlmCall(turnCtx, async () => ({
          content: assistantContent,
          usage: {
            providerRaw: buildProviderRawFromEvent(event, lastAssistant),
          },
        }));
        const physical = shadowConnector.getPhysicalSessionId(logicalSessionId);
        const eventTypes =
          ((shadowResult.metadata as Record<string, any>)?.ecoclawEvents as Array<{ type: string }> | undefined)
            ?.map((e) => e.type)
            .join(",") ?? "";
        logger.debug(
          `[ecoclaw] shadow_runtime logical=${logicalSessionId} physical=${physical ?? "n/a"} events=${eventTypes}`,
        );
      } catch (err: unknown) {
        logger.warn(
          `[ecoclaw] shadow runtime failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    if (typeof api.registerService === "function") {
      api.registerService({
        id: "ecoclaw-runtime",
        start: () => {
          logger.info("[ecoclaw] Plugin active.");
          if (cfg.proxyBaseUrl) {
            logger.info(`[ecoclaw] Proxy mode baseUrl=${cfg.proxyBaseUrl}`);
          } else {
            logger.info("[ecoclaw] Running in hook-only mode (no proxy provider configured).");
          }
          logger.info(
            `[ecoclaw] Runtime mode=${cfg.runtimeMode} stateDir=${cfg.stateDir} autoFork=${cfg.autoForkOnPolicy} cacheTtl=${cfg.cacheTtlSeconds}s summaryTriggerInputTokens=${cfg.summaryTriggerInputTokens}`,
          );
          if (cfg.eventTracePath) {
            logger.info(`[ecoclaw] Event trace path=${cfg.eventTracePath}`);
          }
        },
        stop: () => {
          logger.info("[ecoclaw] Plugin stopped.");
        },
      });
    }
  },
};
