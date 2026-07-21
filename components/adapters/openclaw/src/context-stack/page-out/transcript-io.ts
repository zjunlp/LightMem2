/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { TranscriptSessionRow } from "./transcript-types.js";
import { resolveOpenClawAgentsDir } from "../integration/openclaw-paths.js";

async function findTranscriptPathForSession(sessionId: string): Promise<string | null> {
  const agentsDir = resolveOpenClawAgentsDir();
  try {
    const agentEntries = await readdir(agentsDir, { withFileTypes: true });
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;
      const candidate = join(agentsDir, agentEntry.name, "sessions", `${sessionId}.jsonl`);
      try {
        await readFile(candidate, "utf8");
        return candidate;
      } catch {
        // keep scanning
      }
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeTranscriptMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as Record<string, unknown>;
      const type = typeof block.type === "string" ? block.type : "block";
      if (typeof block.text === "string") return `${type}:${block.text.trim()}`;
      if ((type === "toolCall" || type === "tool_call") && typeof block.name === "string") {
        return `${type}:${block.name}:${JSON.stringify(block.arguments ?? {}, Object.keys(block.arguments ?? {}).sort())}`;
      }
      return JSON.stringify(block);
    })
    .filter((item) => item.length > 0)
    .join("\n")
    .trim();
}

export function transcriptMessageStableId(row: TranscriptSessionRow): string {
  const nativeId = typeof row.id === "string" ? row.id.trim() : "";
  if (nativeId) return nativeId;
  const message = row.message;
  const role = typeof message.role === "string" ? message.role.trim() : "";
  const toolCallId =
    typeof message.toolCallId === "string" ? message.toolCallId.trim()
    : typeof (message as any).tool_call_id === "string" ? String((message as any).tool_call_id).trim()
    : "";
  const toolName =
    typeof message.toolName === "string" ? message.toolName.trim()
    : typeof (message as any).tool_name === "string" ? String((message as any).tool_name).trim()
    : "";
  const timestamp =
    (typeof row.timestamp === "string" && row.timestamp.trim().length > 0 ? row.timestamp.trim() : "")
    || (typeof message.timestamp === "string" ? message.timestamp.trim() : "")
    || (typeof message.timestamp === "number" ? String(message.timestamp) : "");
  const basis = [
    role,
    toolCallId,
    toolName,
    timestamp,
    normalizeTranscriptMessageText(message),
  ].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 20);
}

function splitTranscriptCandidateRecords(raw: string): string[] {
  const records: string[] = [];
  let current = "";
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (line.startsWith('{"type":')) {
      if (current.trim()) records.push(current);
      current = line;
    } else if (current) {
      current += `\n${line}`;
    }
  }
  if (current.trim()) records.push(current);
  return records;
}

function salvageTranscriptMessageRow(candidate: string): TranscriptSessionRow | null {
  const text = String(candidate ?? "");
  if (!text.includes('"type":"message"')) return null;
  if (!text.includes('"role":"toolResult"')) return null;
  const id = text.match(/"id":"([^"\n]+)"/)?.[1];
  const parentId = text.match(/"parentId":"([^"\n]+)"/)?.[1];
  const timestamp = text.match(/"timestamp":"([^"\n]+)"/)?.[1];
  const toolCallId = text.match(/"toolCallId":"([^"\n]+)"/)?.[1];
  const toolName = text.match(/"toolName":"([^"\n]+)"/)?.[1] ?? "tool";
  return {
    id,
    parentId,
    timestamp,
    message: {
      role: "toolResult",
      ...(toolCallId ? { toolCallId } : {}),
      toolName,
      content: [{
        type: "text",
        text: `[Unparseable toolResult omitted: ${toolName}]`,
      }],
      details: {
        contextSafe: {
          transcriptSalvaged: true,
          transcriptSalvageReason: "unparseable_tool_result",
        },
      },
    },
  };
}

export async function readTranscriptEntriesForSession(sessionId: string): Promise<TranscriptSessionRow[] | null> {
  const transcriptPath = await findTranscriptPathForSession(sessionId);
  if (!transcriptPath) return null;
  let raw = "";
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const entries: TranscriptSessionRow[] = [];
  for (const candidate of splitTranscriptCandidateRecords(raw)) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (row.type !== "message") continue;
      const message = row.message;
      if (!message || typeof message !== "object") continue;
      entries.push({
        id: typeof row.id === "string" ? row.id : undefined,
        parentId: typeof row.parentId === "string" ? row.parentId : undefined,
        timestamp: typeof row.timestamp === "string" ? row.timestamp : undefined,
        message: structuredClone(message as Record<string, unknown>),
      });
    } catch {
      const salvaged = salvageTranscriptMessageRow(trimmed);
      if (salvaged) entries.push(salvaged);
    }
  }
  return entries;
}

export async function readTranscriptMessagesForSession(sessionId: string): Promise<any[] | null> {
  const entries = await readTranscriptEntriesForSession(sessionId);
  if (!entries) return null;
  return entries.map((entry) => entry.message);
}
