/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  buildRecoveryContextSafePatch,
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  readArchive,
  resolveArchivePathFromLookup,
  resolveRecoveryStateDir,
} from "@ecoclaw/runtime-core";

export function registerMemoryFaultRecoverTool(
  api: any,
  cfg: { stateDir: string },
  logger: { warn: (message: string) => void },
): void {
  if (typeof api.registerTool !== "function") {
    logger.warn("[plugin-runtime] registerTool unavailable in this OpenClaw version.");
    return;
  }

  api.registerTool((toolCtx: any) => ({
    label: "Memory Fault Recover",
    name: MEMORY_FAULT_RECOVER_TOOL_NAME,
    description:
      "Recover archived content that was trimmed from a prior tool result. Use this internal tool with the provided dataKey instead of re-running the original tool.",
    parameters: {
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
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const dataKey = typeof args?.dataKey === "string" ? args.dataKey.trim() : "";
      if (!dataKey) {
        return {
          content: [{ type: "text", text: "Missing required parameter: dataKey" }],
          details: { error: "missing_data_key" },
        };
      }
      const stateDir = resolveRecoveryStateDir(cfg.stateDir);
      const sessionId =
        typeof toolCtx?.sessionId === "string" && toolCtx.sessionId.trim().length > 0
          ? toolCtx.sessionId.trim()
          : "proxy-session";
      const archivePath =
        (await resolveArchivePathFromLookup(dataKey, stateDir, sessionId))
        ?? (await resolveArchivePathFromLookup(dataKey, stateDir, "proxy-session"))
        ?? "";
      const archive = archivePath ? await readArchive(archivePath) : null;
      if (!archive) {
        return {
          content: [{ type: "text", text: `No archived content found for dataKey: ${dataKey}` }],
          details: { error: "archive_not_found", dataKey, archivePath },
        };
      }

      const recoveredText =
        `[Memory Fault Recovery] Recovered content for: ${dataKey}\n` +
        `Original size: ${archive.originalSize.toLocaleString()} chars\n` +
        `Archived by: ${archive.sourcePass}\n` +
        `--- Recovered Content ---\n` +
        `${archive.originalText}\n` +
        `--- End Recovered Content ---`;

      return {
        content: [{ type: "text", text: recoveredText }],
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
    },
  }), { name: MEMORY_FAULT_RECOVER_TOOL_NAME });
}
