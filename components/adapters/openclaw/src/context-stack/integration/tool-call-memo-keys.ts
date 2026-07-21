/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile } from "node:fs/promises";
import {
  extractArgsLike,
  extractToolParams,
  findTranscriptPathInCommand,
  isRecord,
  isTranscriptLikePath,
  isUnsafeExecCommand,
  maybeHashFile,
  resolveMaybePath,
  trimText,
} from "./tool-call-memo-shared.js";

export async function buildMemoKey(event: any): Promise<string | undefined> {
  const toolName = trimText(event?.toolName).toLowerCase();
  const params = extractToolParams(event);
  const target = extractArgsLike(params);

  if (toolName === "read") {
    const pathValue = trimText(target.file_path ?? target.filePath ?? target.path);
    if (!isTranscriptLikePath(pathValue)) return undefined;
    const resolvedPath = resolveMaybePath(pathValue);
    if (!resolvedPath) return undefined;
    const fileHash = await maybeHashFile(pathValue);
    return `transcript:${resolvedPath}:${fileHash ?? "nohash"}`;
  }

  if (toolName !== "exec" && toolName !== "bash") return undefined;
  const command = trimText(target.command ?? target.cmd ?? target.script);
  if (!command || isUnsafeExecCommand(command)) return undefined;
  const transcriptPath = findTranscriptPathInCommand(command);
  if (!transcriptPath) return undefined;
  const workdir = trimText(target.workdir ?? target.cwd);
  const resolvedPath = resolveMaybePath(transcriptPath, workdir);
  if (!resolvedPath) return undefined;
  const fileHash = await maybeHashFile(transcriptPath, workdir);
  return `transcript:${resolvedPath}:${fileHash ?? "nohash"}`;
}

export async function extractTranscriptFullText(event: any): Promise<string | undefined> {
  const toolName = trimText(event?.toolName).toLowerCase();
  const params = extractToolParams(event);
  const target = extractArgsLike(params);

  if (toolName === "read") {
    const pathValue = trimText(target.file_path ?? target.filePath ?? target.path);
    if (!isTranscriptLikePath(pathValue)) return undefined;
    const resolved = resolveMaybePath(pathValue);
    if (!resolved) return undefined;
    try {
      return await readFile(resolved, "utf8");
    } catch {
      return undefined;
    }
  }

  if (toolName !== "exec" && toolName !== "bash") return undefined;
  const command = trimText(target.command ?? target.cmd ?? target.script);
  if (!command || isUnsafeExecCommand(command)) return undefined;
  const transcriptPath = findTranscriptPathInCommand(command);
  if (!transcriptPath) return undefined;
  const workdir = trimText(target.workdir ?? target.cwd);
  const resolved = resolveMaybePath(transcriptPath, workdir);
  if (!resolved) return undefined;
  try {
    return await readFile(resolved, "utf8");
  } catch {
    return undefined;
  }
}

export function extractTextFromToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result) return "";
  if (Array.isArray(result)) {
    return result.map((item) => extractTextFromToolResult(item)).filter((item) => item.length > 0).join("\n");
  }
  if (!isRecord(result)) return "";
  if (typeof result.text === "string") return result.text;
  if (typeof result.stdout === "string" || typeof result.stderr === "string") {
    return [result.stdout, result.stderr].filter((item): item is string => typeof item === "string" && item.length > 0).join("\n");
  }
  if (Array.isArray(result.content)) {
    return result.content
      .map((item) => {
        if (!isRecord(item)) return "";
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
        return "";
      })
      .filter((item) => item.length > 0)
      .join("\n");
  }
  if (isRecord(result.result)) return extractTextFromToolResult(result.result);
  if (typeof result.result === "string") return result.result;
  return "";
}
