import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  buildRecoveryContextSafePatch,
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  readArchive,
  resolveArchivePathAcrossSessions,
  resolveRecoveryStateDir,
} from "@tokenpilot/runtime-core";

export const TOKENPILOT_MCP_SERVER_NAME = "tokenpilot_memory_fault_recover";
export { MEMORY_FAULT_RECOVER_TOOL_NAME } from "@tokenpilot/runtime-core";

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

function packageRootFromHere(): string {
  const moduleDir = __dirname;
  const fromDist = resolve(moduleDir, "..");
  if (existsSync(join(fromDist, "package.json")) && existsSync(join(fromDist, "dist", "server.js"))) {
    return fromDist;
  }
  let current = resolve(moduleDir, "..");
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "src", "server.ts"))) {
      return current;
    }
    current = dirname(current);
  }
  return fromDist;
}

export function resolveTokenPilotMcpServerSpec(params?: {
  stateDir?: string;
  requireBuild?: boolean;
}): TokenPilotMcpServerSpec {
  const packageRoot = packageRootFromHere();
  const entryPath = join(packageRoot, "dist", "server.js");
  if (params?.requireBuild !== false && !existsSync(entryPath)) {
    throw new Error(
      `TokenPilot MCP server is not built yet: ${entryPath}. Run \`pnpm --dir <repo> --filter @tokenpilot/mcp build\` first.`,
    );
  }
  return {
    serverName: TOKENPILOT_MCP_SERVER_NAME,
    command: process.execPath,
    args: [entryPath],
    env: {
      TOKENPILOT_STATE_DIR: resolveRecoveryStateDir(params?.stateDir),
    },
    entryPath,
  };
}

export async function inspectClaudeMcpServerConfig(configPath: string, serverName = TOKENPILOT_MCP_SERVER_NAME): Promise<{
  installed: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
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
    };
  } catch {
    return { installed: false };
  }
}

export async function resolveMemoryFaultRecover(params: {
  dataKey: string;
  stateDir?: string;
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

  return {
    text:
      `[Memory Fault Recovery] Recovered content for: ${dataKey}\n`
      + `Original size: ${archive.originalSize.toLocaleString()} chars\n`
      + `Archived by: ${archive.sourcePass}\n`
      + `--- Recovered Content ---\n`
      + `${archive.originalText}\n`
      + "--- End Recovered Content ---",
    details: {
      dataKey,
      archivePath,
      originalSize: archive.originalSize,
      sourcePass: archive.sourcePass,
      toolName: archive.toolName,
      recovered: true,
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
          name: "tokenpilot-memory-fault-recover",
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
