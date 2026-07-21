import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  buildRecoveryContextSafePatch,
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  readArchive,
  renderRecoveredArchive,
  resolveArchivePathAcrossSessions,
  resolveRecoveryStateDir,
} from "@tokenpilot/artifact-store";
import { TOKENPILOT_RECOVERY_MCP_PRODUCT } from "./product-registration.js";

export { TOKENPILOT_RECOVERY_MCP_PRODUCT } from "./product-registration.js";

export const TOKENPILOT_MCP_SERVER_NAME = "tokenpilot_memory_fault_recover";
export const DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC = 90;
export const DEFAULT_TOKENPILOT_MCP_INSTALL_PROBE_TIMEOUT_MS = 15_000;
export { MEMORY_FAULT_RECOVER_TOOL_NAME } from "@tokenpilot/artifact-store";

export type TokenPilotMcpServerSpec = {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  entryPath: string;
};

export type MemoryFaultRecoverResult = {
  text: string;
  details: Record<string, unknown>;
};

export type TokenPilotMcpProbeResult = {
  ok: boolean;
  detail: string;
  timedOut: boolean;
};

export type TokenPilotObservedMcpConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  startupTimeoutSec?: number;
};

export type TokenPilotMcpHealthSummary = {
  installed: boolean;
  stateDirMatches: boolean;
  commandMatches: boolean;
  argsMatch: boolean;
  startupTimeoutSecMatches: boolean;
  healthy: boolean;
};

function packageRootFromHere(): string {
  return resolveTokenPilotMcpPackageRoot();
}

function isTokenPilotMcpPackageRoot(candidate: string): boolean {
  const packageJsonPath = join(candidate, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  if (!existsSync(join(candidate, "dist", "server.js")) && !existsSync(join(candidate, "src", "server.ts"))) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
    return parsed.name === "@tokenpilot/mcp";
  } catch {
    return false;
  }
}

export function resolveTokenPilotMcpPackageRoot(params?: {
  moduleDir?: string;
  cwd?: string;
  override?: string | null;
}): string {
  const override = params?.override?.trim() || process.env.TOKENPILOT_MCP_PACKAGE_ROOT?.trim();
  if (override) {
    return resolve(override);
  }
  const moduleDir = params?.moduleDir ?? __dirname;
  const fromDist = resolve(moduleDir, "..");
  if (isTokenPilotMcpPackageRoot(fromDist)) {
    return fromDist;
  }
  let current = resolve(moduleDir, "..");
  for (let i = 0; i < 10; i += 1) {
    const directCandidate = join(current, "components", "products", "mcp");
    if (isTokenPilotMcpPackageRoot(directCandidate)) {
      return directCandidate;
    }
    if (isTokenPilotMcpPackageRoot(current)) {
      return current;
    }
    current = dirname(current);
  }
  current = resolve(params?.cwd ?? process.cwd());
  for (let i = 0; i < 10; i += 1) {
    const directCandidate = join(current, "components", "products", "mcp");
    if (isTokenPilotMcpPackageRoot(directCandidate)) {
      return directCandidate;
    }
    if (isTokenPilotMcpPackageRoot(current)) {
      return current;
    }
    current = dirname(current);
  }
  return fromDist;
}

function buildTokenPilotMcpServerSpec(entryPath: string, stateDir?: string): TokenPilotMcpServerSpec {
  return {
    serverName: TOKENPILOT_MCP_SERVER_NAME,
    command: process.execPath,
    args: [entryPath],
    env: {
      TOKENPILOT_STATE_DIR: resolveRecoveryStateDir(stateDir),
    },
    entryPath,
  };
}

export function resolveTokenPilotMcpServerSpec(params?: {
  stateDir?: string;
  requireBuild?: boolean;
}): TokenPilotMcpServerSpec {
  const packageRoot = packageRootFromHere();
  const distEntryPath = join(packageRoot, "dist", "server.js");
  if (params?.requireBuild !== false && !existsSync(distEntryPath)) {
    throw new Error(
      `TokenPilot MCP server is not built yet: ${distEntryPath}. Run \`pnpm --dir <repo> --filter @tokenpilot/mcp build\` first.`,
    );
  }
  return buildTokenPilotMcpServerSpec(distEntryPath, params?.stateDir);
}

export function resolveTokenPilotMcpProbeServerSpec(params?: {
  stateDir?: string;
  requireBuild?: boolean;
}): TokenPilotMcpServerSpec {
  const packageRoot = packageRootFromHere();
  const distEntryPath = join(packageRoot, "dist", "server.js");
  const srcEntryPath = join(packageRoot, "src", "server.ts");
  const runningViaTsx =
    process.execArgv.includes("--import")
    && process.execArgv.some((value) => value.includes("tsx"));

  if (runningViaTsx && existsSync(srcEntryPath)) {
    return {
      serverName: TOKENPILOT_MCP_SERVER_NAME,
      command: process.execPath,
      args: ["--import", "tsx", srcEntryPath],
      env: {
        TOKENPILOT_STATE_DIR: resolveRecoveryStateDir(params?.stateDir),
      },
      entryPath: srcEntryPath,
    };
  }

  if (existsSync(distEntryPath)) {
    return buildTokenPilotMcpServerSpec(distEntryPath, params?.stateDir);
  }
  if (existsSync(srcEntryPath)) {
    return {
      serverName: TOKENPILOT_MCP_SERVER_NAME,
      command: process.execPath,
      args: ["--import", "tsx", srcEntryPath],
      env: {
        TOKENPILOT_STATE_DIR: resolveRecoveryStateDir(params?.stateDir),
      },
      entryPath: srcEntryPath,
    };
  }
  if (params?.requireBuild !== false) {
    throw new Error(
      `TokenPilot MCP server is not built yet: ${distEntryPath}. Run \`pnpm --dir <repo> --filter @tokenpilot/mcp build\` first.`,
    );
  }
  return buildTokenPilotMcpServerSpec(distEntryPath, params?.stateDir);
}

export type TokenPilotMcpWireProtocol = "newline_json" | "content_length";

export function encodeMcpMessage(message: unknown, protocol: TokenPilotMcpWireProtocol = "newline_json"): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (protocol === "content_length") {
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    return Buffer.concat([header, body]);
  }
  return Buffer.concat([body, Buffer.from("\n", "utf8")]);
}

function tryReadContentLengthMcpInitializeResponse(buffer: Buffer): {
  ok: boolean;
  detail: string;
} | null {
  const boundary = buffer.indexOf("\r\n\r\n");
  if (boundary < 0) return null;
  const headerText = buffer.slice(0, boundary).toString("utf8");
  const contentLengthMatch = /^content-length:\s*(\d+)$/im.exec(headerText);
  if (!contentLengthMatch) {
    return {
      ok: false,
      detail: "missing Content-Length header in MCP initialize response",
    };
  }
  const contentLength = Number(contentLengthMatch[1]);
  const bodyStart = boundary + 4;
  const bodyEnd = bodyStart + contentLength;
  if (buffer.length < bodyEnd) return null;

  try {
    const parsed = JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf8")) as {
      error?: { message?: string };
      result?: { serverInfo?: { name?: string } };
    };
    if (parsed?.error?.message) {
      return {
        ok: false,
        detail: `MCP initialize failed: ${parsed.error.message}`,
      };
    }
    return {
      ok: true,
      detail: `MCP initialize succeeded (${parsed?.result?.serverInfo?.name ?? "server"})`,
    };
  } catch {
    return {
      ok: false,
      detail: "invalid JSON in MCP initialize response",
    };
  }
}

function tryReadNewlineMcpInitializeResponse(buffer: Buffer): {
  ok: boolean;
  detail: string;
} | null {
  const newlineIndex = buffer.indexOf("\n");
  if (newlineIndex < 0) return null;
  const line = buffer.slice(0, newlineIndex).toString("utf8").trim();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as {
      error?: { message?: string };
      result?: { serverInfo?: { name?: string } };
    };
    if (parsed?.error?.message) {
      return {
        ok: false,
        detail: `MCP initialize failed: ${parsed.error.message}`,
      };
    }
    return {
      ok: true,
      detail: `MCP initialize succeeded (${parsed?.result?.serverInfo?.name ?? "server"})`,
    };
  } catch {
    return {
      ok: false,
      detail: "invalid JSON in newline MCP initialize response",
    };
  }
}

export async function probeTokenPilotMcpServer(
  spec: TokenPilotMcpServerSpec,
  params?: {
    timeoutMs?: number;
    clientName?: string;
    clientVersion?: string;
    protocol?: TokenPilotMcpWireProtocol;
  },
): Promise<TokenPilotMcpProbeResult> {
  const timeoutMs = params?.timeoutMs ?? DEFAULT_TOKENPILOT_MCP_INSTALL_PROBE_TIMEOUT_MS;
  const clientName = params?.clientName?.trim() || "tokenpilot-mcp-probe";
  const clientVersion = params?.clientVersion?.trim() || "0.1.0";
  const protocol = params?.protocol ?? "newline_json";

  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...spec.env,
      },
    });

    let settled = false;
    let stdoutBuffer = Buffer.alloc(0);
    let stderrBuffer = "";

    const finish = (result: TokenPilotMcpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        timedOut: true,
        detail: `MCP initialize timed out after ${Math.ceil(timeoutMs / 1000)} seconds`,
      });
    }, timeoutMs);

    child.once("error", (error) => {
      finish({
        ok: false,
        timedOut: false,
        detail: `failed to start MCP process: ${error.message}`,
      });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBuffer = Buffer.concat([
        stdoutBuffer,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      const parsed = protocol === "content_length"
        ? tryReadContentLengthMcpInitializeResponse(stdoutBuffer)
        : tryReadNewlineMcpInitializeResponse(stdoutBuffer);
      if (!parsed) return;
      finish({
        ok: parsed.ok,
        timedOut: false,
        detail: parsed.ok
          ? parsed.detail
          : `${parsed.detail}${stderrBuffer.trim() ? ` | stderr: ${stderrBuffer.trim()}` : ""}`,
      });
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      finish({
        ok: false,
        timedOut: false,
        detail:
          `MCP process exited before initialize response`
          + ` (code=${code ?? "null"}, signal=${signal ?? "null"})`
          + `${stderrBuffer.trim() ? ` | stderr: ${stderrBuffer.trim()}` : ""}`,
      });
    });

    child.stdin.write(encodeMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: clientName,
          version: clientVersion,
        },
      },
    }, protocol));
  });
}

export function inspectTokenPilotMcpHealth(params: {
  observed?: TokenPilotObservedMcpConfig | null;
  expected: TokenPilotMcpServerSpec;
  expectedStateDir: string;
  expectedStartupTimeoutSec?: number;
}): TokenPilotMcpHealthSummary {
  const observed = params.observed ?? undefined;
  const expectedStartupTimeoutSec =
    params.expectedStartupTimeoutSec ?? DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC;
  const argsMatch =
    Array.isArray(observed?.args)
    && observed.args.length === params.expected.args.length
    && observed.args.every((value, index) => value === params.expected.args[index]);
  const installed = Boolean(observed?.command);
  const stateDirMatches = observed?.env?.TOKENPILOT_STATE_DIR === params.expectedStateDir;
  const commandMatches = observed?.command === params.expected.command;
  const startupTimeoutSecMatches = observed?.startupTimeoutSec === expectedStartupTimeoutSec;
  return {
    installed,
    stateDirMatches,
    commandMatches,
    argsMatch,
    startupTimeoutSecMatches,
    healthy:
      installed
      && stateDirMatches
      && commandMatches
      && argsMatch
      && startupTimeoutSecMatches,
  };
}

export async function inspectClaudeMcpServerConfig(configPath: string, serverName = TOKENPILOT_MCP_SERVER_NAME): Promise<{
  installed: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  startupTimeoutSec?: number;
}> {
  if (!existsSync(configPath)) return { installed: false };
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    const entry = raw?.mcpServers?.[serverName];
    if (!entry || typeof entry !== "object") return { installed: false };
    const args = Array.isArray(entry.args) ? entry.args.map((value: unknown) => String(value)) : [];
    const env = entry.env && typeof entry.env === "object"
      ? Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, String(value)]))
      : {};
    return {
      installed: typeof entry.command === "string" && entry.command.length > 0,
      command: typeof entry.command === "string" ? entry.command : undefined,
      args,
      env,
      startupTimeoutSec:
        typeof entry.startup_timeout_sec === "number"
          ? entry.startup_timeout_sec
          : typeof entry.startupTimeoutSec === "number"
            ? entry.startupTimeoutSec
            : undefined,
    };
  } catch {
    return { installed: false };
  }
}

export async function resolveMemoryFaultRecover(params: {
  dataKey: string;
  stateDir?: string;
  startLine?: number;
  endLine?: number;
}): Promise<MemoryFaultRecoverResult> {
  const dataKey = params.dataKey.trim();
  if (!dataKey) {
    return {
      text: "Missing required parameter: dataKey",
      details: { error: "missing_data_key" },
    };
  }

  const stateDir = resolveRecoveryStateDir(params.stateDir);
  const archivePath = await resolveArchivePathAcrossSessions(dataKey, stateDir);
  const archive = archivePath ? await readArchive(archivePath) : null;
  if (!archive) {
    return {
      text: `No archived content found for dataKey: ${dataKey}`,
      details: { error: "archive_not_found", dataKey, stateDir },
    };
  }

  const rendered = renderRecoveredArchive({
    dataKey,
    archive,
    startLine: params.startLine,
    endLine: params.endLine,
  });

  return {
    text: rendered.text,
    details: {
      dataKey,
      archivePath,
      ...rendered.details,
      contextSafe: {
        ...buildRecoveryContextSafePatch(MEMORY_FAULT_RECOVER_TOOL_NAME),
      },
    },
  };
}

type JsonRpcId = string | number | null;

type McpRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type McpResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
};

export async function handleMcpRequest(message: McpRequest, params?: {
  stateDir?: string;
}): Promise<McpResponse | null> {
  const id = message.id ?? null;
  const method = typeof message.method === "string" ? message.method : "";
  if (!method) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid request" },
    };
  }

  if (method === "notifications/initialized" || id === null) {
    return null;
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: TOKENPILOT_RECOVERY_MCP_PRODUCT.productId,
          version: "0.1.0",
        },
      },
    };
  }

  if (method === "ping") {
    return {
      jsonrpc: "2.0",
      id,
      result: {},
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: MEMORY_FAULT_RECOVER_TOOL_NAME,
            description:
              "Recover archived content that was trimmed from a prior tool result. Use this internal tool with the provided dataKey instead of re-running the original tool.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                dataKey: {
                  type: "string",
                  description: "Archive dataKey from a prior [Tool payload trimmed] notice.",
                },
                startLine: {
                  type: "integer",
                  minimum: 1,
                  description: "Optional 1-based start line for partial recovery.",
                },
                endLine: {
                  type: "integer",
                  minimum: 1,
                  description: "Optional 1-based end line for partial recovery.",
                },
              },
              required: ["dataKey"],
            },
          },
        ],
      },
    };
  }

  if (method === "tools/call") {
    const toolName = typeof message.params?.name === "string" ? message.params.name : "";
    if (toolName !== MEMORY_FAULT_RECOVER_TOOL_NAME) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${toolName || "(missing)"}` },
      };
    }
    const argumentsObject =
      message.params?.arguments && typeof message.params.arguments === "object" && !Array.isArray(message.params.arguments)
        ? message.params.arguments as Record<string, unknown>
        : {};
    const result = await resolveMemoryFaultRecover({
      dataKey: typeof argumentsObject.dataKey === "string" ? argumentsObject.dataKey : "",
      stateDir: params?.stateDir,
      startLine: typeof argumentsObject.startLine === "number" ? argumentsObject.startLine : undefined,
      endLine: typeof argumentsObject.endLine === "number" ? argumentsObject.endLine : undefined,
    });
    const isError = typeof result.details.error === "string";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: result.text }],
        structuredContent: result.details,
        isError,
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

export async function listClaudeMcpConfigCandidates(primaryPath: string): Promise<string[]> {
  const results = [primaryPath];
  const dir = dirname(primaryPath);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === ".claude.json" || entry.name === "mcp.json") {
        const next = join(dir, entry.name);
        if (!results.includes(next)) results.push(next);
      }
    }
  } catch {
    // Ignore filesystem probing errors.
  }
  return results;
}
