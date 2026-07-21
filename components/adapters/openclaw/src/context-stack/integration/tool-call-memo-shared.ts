/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export type MemoRecord = {
  toolName: string;
  memoKey: string;
  dataKey: string;
  outputFile?: string;
  resultHash: string;
  createdAt: string;
};

export type MemoHelpers = {
  safeId: (value: string) => string;
  appendTaskStateTrace?: (stateDir: string, payload: Record<string, unknown>) => Promise<void>;
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
  };
};

export const TOOL_RESULT_MEMO = new Map<string, MemoRecord>();
export const TOOL_ACCESS_COUNT = new Map<string, number>();
export const MAX_MEMO_RECORDS = 2048;
export const DEFAULT_TRANSCRIPT_MEMO_MIN_CALLS_BEFORE_BLOCK = 4;

export function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function extractToolParams(event: any): Record<string, unknown> {
  return isRecord(event?.params) ? { ...(event.params as Record<string, unknown>) } : {};
}

export function extractArgsLike(params: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(params.args)) return { ...(params.args as Record<string, unknown>) };
  if (isRecord(params.arguments)) return { ...(params.arguments as Record<string, unknown>) };
  return params;
}

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isTranscriptLikePath(pathValue: string): boolean {
  const lower = pathValue.trim().toLowerCase();
  return lower.endsWith(".md") && lower.includes("transcript");
}

export function resolveMaybePath(pathValue: string, workdir?: string): string | undefined {
  const trimmed = pathValue.trim();
  if (!trimmed) return undefined;
  if (isAbsolute(trimmed)) return trimmed;
  if (workdir && workdir.trim().length > 0) return resolve(workdir.trim(), trimmed);
  return undefined;
}

export async function maybeHashFile(pathValue: string, workdir?: string): Promise<string | undefined> {
  const resolved = resolveMaybePath(pathValue, workdir);
  if (!resolved) return undefined;
  try {
    const content = await readFile(resolved);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

export function findTranscriptPathInCommand(command: string): string | undefined {
  const match = command.match(/([A-Za-z0-9_./-]*transcript(?:[_-][A-Za-z0-9_-]+)?\.md)/i);
  return match?.[1]?.trim();
}

export function isUnsafeExecCommand(command: string): boolean {
  const normalized = ` ${command.toLowerCase()} `;
  return (
    normalized.includes(" >")
    || normalized.includes(" >>")
    || normalized.includes(" tee ")
    || normalized.includes(" rm ")
    || normalized.includes(" mv ")
    || normalized.includes(" cp ")
    || normalized.includes(" chmod ")
    || normalized.includes(" chown ")
    || normalized.includes(" mkdir ")
    || normalized.includes(" touch ")
    || normalized.includes(" git commit")
    || normalized.includes(" git add")
    || normalized.includes(" npm ")
    || normalized.includes(" pnpm ")
    || normalized.includes(" yarn ")
    || normalized.includes(" pytest")
    || normalized.includes(" cargo ")
    || normalized.includes(" make ")
  );
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function buildDataKey(toolName: string, toolCallId: string, text: string): string {
  const base = toolCallId || hashText(text);
  return `memo:${toolName}:${base}`;
}

export function insertMemoRecord(record: MemoRecord): void {
  TOOL_RESULT_MEMO.set(record.memoKey, record);
  while (TOOL_RESULT_MEMO.size > MAX_MEMO_RECORDS) {
    const oldest = TOOL_RESULT_MEMO.keys().next().value;
    if (!oldest) break;
    TOOL_RESULT_MEMO.delete(oldest);
  }
}

export function getTranscriptMemoMinCallsBeforeBlock(): number {
  const raw = Number.parseInt(process.env.TOKENPILOT_TRANSCRIPT_MEMO_MIN_CALLS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_TRANSCRIPT_MEMO_MIN_CALLS_BEFORE_BLOCK;
}
