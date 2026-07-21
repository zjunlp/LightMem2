/* eslint-disable @typescript-eslint/no-explicit-any */
import { join, dirname } from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import { pluginStateDirWriteTargets, pluginStateSubdirWriteTargets } from "@lightmem2/artifact-store";

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

export async function appendJsonl(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(toJsonSafe(payload))}\n`, "utf8");
}

export async function appendTaskStateTrace(stateDir: string, payload: Record<string, unknown>): Promise<void> {
  const record = {
    at: new Date().toISOString(),
    ...payload,
  };
  for (const root of pluginStateDirWriteTargets(stateDir)) {
    await appendJsonl(join(root, "task-state", "trace.jsonl"), record);
  }
}

export async function appendForwardedInputDump(
  stateDir: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const safeSessionId = String(sessionId || "session").replace(/[^a-zA-Z0-9._-]+/g, "_");
  for (const path of pluginStateSubdirWriteTargets(stateDir, "forwarded-inputs", `${safeSessionId}.jsonl`)) {
    await appendJsonl(path, payload);
  }
}

export async function appendReductionPassTrace(
  stateDir: string,
  payload: {
    at: string;
    stage: "proxy_inbound" | "proxy_response";
    model: string;
    upstreamModel: string;
    promptCacheKey: string;
    requestId: string;
    report: Array<{
      id: string;
      phase: string;
      target: string;
      changed: boolean;
      note?: string;
      skippedReason?: string;
      beforeChars?: number;
      afterChars?: number;
      touchedSegmentIds?: string[];
    }>;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  if (!Array.isArray(payload.report) || payload.report.length === 0) return;
  const tracePaths = pluginStateSubdirWriteTargets(stateDir, "reduction-pass-trace.jsonl");
  for (const entry of payload.report) {
    const beforeChars = Number(entry.beforeChars ?? 0);
    const afterChars = Number(entry.afterChars ?? beforeChars);
    const record = {
      at: payload.at,
      stage: payload.stage,
      requestId: payload.requestId,
      model: payload.model,
      upstreamModel: payload.upstreamModel,
      promptCacheKey: payload.promptCacheKey,
      passId: entry.id,
      phase: entry.phase,
      target: entry.target,
      changed: Boolean(entry.changed),
      note: entry.note ?? "",
      skippedReason: entry.skippedReason ?? "",
      beforeChars,
      afterChars,
      savedChars: Math.max(0, beforeChars - afterChars),
      touchedSegmentIds: Array.isArray(entry.touchedSegmentIds) ? entry.touchedSegmentIds : [],
      extra: payload.extra ?? {},
    };
    for (const tracePath of tracePaths) {
      await appendJsonl(tracePath, record);
    }
  }
}
