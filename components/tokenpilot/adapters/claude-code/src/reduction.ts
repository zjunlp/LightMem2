/* eslint-disable @typescript-eslint/no-explicit-any */
import type { HostPayloadCodec, HostRequestEnvelope } from "@tokenpilot/host-adapter";
import type { ContextSegment, RuntimeTurnContext } from "@tokenpilot/kernel";
import {
  analyzeExecOutputTruncation,
  analyzeToolPayloadTrim,
} from "@tokenpilot/decision";
import {
  resolveReductionPasses,
  runReductionBeforeCall,
} from "@tokenpilot/runtime-core";
import type { TokenPilotClaudeCodeConfig } from "./config.js";
import { loadClaudeCodeSessionSnapshot } from "./session-state.js";

type ClaudeSegmentBinding = {
  segmentId: string;
  messageIndex: number;
  blockIndex?: number;
  field: "content" | "text";
  toolName?: string;
};

type ClaudeReductionInstruction = {
  strategy: string;
  segmentIds: string[];
  confidence: number;
  priority: number;
  rationale: string;
  parameters?: Record<string, unknown>;
};

export type ClaudeReductionPassEffect = {
  id: string;
  changed: boolean;
  skippedReason?: string;
  note?: string;
  beforeChars: number;
  afterChars: number;
  savedChars: number;
  touchedSegmentIds?: string[];
};

export type ClaudeReductionDiagnostics = {
  messageCount: number;
  toolLikeMessages: number;
  candidateSegments: number;
  candidateChars: number;
};

type ClaudeReductionReportEntry = {
  id: string;
  phase: string;
  target: string;
  changed: boolean;
  skippedReason?: string;
  note?: string;
  beforeChars: number;
  afterChars: number;
  touchedSegmentIds?: string[];
};

export type ClaudeReductionVisualSegment = {
  segmentId: string;
  messageIndex: number;
  field: "content" | "text" | "arguments" | "output" | "result";
  blockIndex?: number;
  toolName?: string;
  savedChars: number;
  beforeText: string;
  afterText: string;
  report: ClaudeReductionReportEntry[];
};

export type ClaudeReductionSummary = {
  changedMessages: number;
  changedBlocks: number;
  savedChars: number;
  beforeChars: number;
  afterChars: number;
  report: ClaudeReductionReportEntry[];
  passEffects: ClaudeReductionPassEffect[];
  diagnostics: ClaudeReductionDiagnostics;
  visualSegments?: ClaudeReductionVisualSegment[];
  disclosedReadPaths?: string[];
  skippedReason?: string;
};

function normalizeDisclosedReadPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const next = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase();
    if (normalized) next.add(normalized);
  }
  return next.size > 0 ? [...next] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractPathHint(value: unknown): string | undefined {
  const record = asRecord(value);
  const candidates = [
    record.path,
    record.file_path,
    record.filePath,
    record.filename,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function stringifyStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function payloadKindForText(text: string): "stdout" | "stderr" | "json" | "blob" {
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      return "stdout";
    }
  }
  if (/(\bstderr\b|error:|traceback|exception)/i.test(text)) return "stderr";
  if (isHtmlLikeText(text)) return "blob";
  if (text.length > 500 && countLines(text) <= 2) return "blob";
  return "stdout";
}

function isHtmlLikeText(text: string): boolean {
  return /<\/?(html|body|main|section|article|nav|script|style|div|span|a|p|ul|ol|li|table|meta|link)\b/i.test(text);
}

function looksLikeWebPayload(text: string): boolean {
  if (isHtmlLikeText(text)) return true;
  return /\b(<!doctype html|<head\b|<body\b|href=|src=|aria-|data-|document\.|window\.)/i.test(text);
}

function countLines(text: string): number {
  const matches = text.match(/\n/g);
  return matches ? matches.length + 1 : text.length > 0 ? 1 : 0;
}

function thresholdForTool(toolName: string, config: TokenPilotClaudeCodeConfig): number {
  const normalized = toolName.toLowerCase();
  const optionThresholds = config.reduction.passOptions.execOutputTruncation?.toolThresholds;
  if (optionThresholds && typeof optionThresholds === "object" && normalized in optionThresholds) {
    const value = Number((optionThresholds as Record<string, unknown>)[normalized]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  if (normalized === "bash" || normalized === "shell" || normalized === "powershell") return 30_000;
  if (normalized === "grep" || normalized === "rg") return 20_000;
  if (normalized === "read" || normalized === "file_read") return Infinity;
  return 50_000;
}

function segmentForText(params: {
  id: string;
  text: string;
  source: string;
  toolName?: string;
  latestUserQuery: string;
  mimeType?: string;
  path?: string;
}): ContextSegment {
  const payloadKind = payloadKindForText(params.text);
  return {
    id: params.id,
    kind: "volatile",
    text: params.text,
    priority: 30,
    source: params.source,
    metadata: {
      role: "tool",
      isToolPayload: true,
      payloadKind,
      latestUserQuery: params.latestUserQuery,
      ...(params.path ? { path: params.path } : {}),
      ...(params.mimeType ? { mimeType: params.mimeType } : {}),
      toolPayload: {
        enabled: true,
        kind: payloadKind,
        toolName: params.toolName ?? "tool",
        ...(params.path ? { path: params.path } : {}),
      },
      reduction: {
        target: "tool_payload",
        payloadKind,
        toolPayloadTrim: {
          enabled: true,
          kind: payloadKind,
        },
      },
    },
  };
}

function extractLatestUserQuery(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = asRecord(messages[i]);
    if (message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;
    const parts = content
      .map((block) => {
        const entry = asRecord(block);
        return typeof entry.text === "string" ? entry.text : typeof entry.content === "string" ? entry.content : "";
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  return "";
}

function buildTurnContext(
  payload: any,
  sessionId: string,
  options?: { disclosedReadPaths?: string[] },
): {
  turnCtx: RuntimeTurnContext;
  bindings: ClaudeSegmentBinding[];
  diagnostics: ClaudeReductionDiagnostics;
} {
  const segments: ContextSegment[] = [];
  const bindings: ClaudeSegmentBinding[] = [];
  const latestUserQuery = extractLatestUserQuery(payload?.messages);
  const toolUseHints = new Map<string, { toolName?: string; path?: string }>();
  let messageCount = 0;
  let toolLikeMessages = 0;

  if (Array.isArray(payload?.messages)) {
    payload.messages.forEach((message: any, messageIndex: number) => {
      const item = asRecord(message);
      const content = item.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const entry = asRecord(block);
          const type = String(entry.type ?? "").toLowerCase();
          if (type !== "tool_use") continue;
          const toolUseId = typeof entry.id === "string" ? entry.id : "";
          if (!toolUseId) continue;
          toolUseHints.set(toolUseId, {
            toolName: typeof entry.name === "string" ? entry.name : undefined,
            path: extractPathHint(entry.input),
          });
        }
      }
      if (!Array.isArray(content)) {
        if (item.role === "tool" && typeof content === "string") {
          messageCount += 1;
          toolLikeMessages += 1;
          const id = `message-${messageIndex}-content`;
          segments.push(segmentForText({
            id,
            text: content,
            source: "anthropic.messages.content",
            latestUserQuery,
          }));
          bindings.push({ segmentId: id, messageIndex, field: "content" });
        }
        return;
      }

      messageCount += 1;
      let countedToolLike = false;
      content.forEach((block: any, blockIndex: number) => {
        const entry = asRecord(block);
        const type = String(entry.type ?? "").toLowerCase();
        if (type !== "tool_result") return;
        if (!countedToolLike) {
          toolLikeMessages += 1;
          countedToolLike = true;
        }
        const text = typeof entry.text === "string"
          ? entry.text
          : typeof entry.content === "string"
            ? entry.content
            : stringifyStructuredValue(entry.content);
        if (!text) return;
        const toolUseId = typeof entry.tool_use_id === "string" ? entry.tool_use_id : "";
        const hint = toolUseId ? toolUseHints.get(toolUseId) : undefined;
        const id = `message-${messageIndex}-block-${blockIndex}`;
        segments.push(segmentForText({
          id,
          text,
          source: "anthropic.messages.tool_result",
          toolName: typeof entry.name === "string" ? entry.name : hint?.toolName,
          latestUserQuery,
          mimeType: typeof entry.mime_type === "string" ? entry.mime_type : undefined,
          path: hint?.path,
        }));
        bindings.push({
          segmentId: id,
          messageIndex,
          blockIndex,
          field: typeof entry.text === "string" ? "text" : "content",
          toolName: typeof entry.name === "string" ? entry.name : hint?.toolName,
        });
      });
    });
  }

  return {
    turnCtx: {
      sessionId,
      sessionMode: "single",
      provider: "claude-code",
      model: typeof payload?.model === "string" ? payload.model : "",
      apiFamily: "anthropic-messages",
      prompt: latestUserQuery,
      budget: {
        maxInputTokens: 0,
        reserveOutputTokens: 0,
      },
      segments,
      metadata: {
        latestUserQuery,
        ...(options?.disclosedReadPaths ? { disclosedReadPaths: options.disclosedReadPaths } : {}),
      },
    },
    bindings,
    diagnostics: {
      messageCount,
      toolLikeMessages,
      candidateSegments: segments.length,
      candidateChars: segments.reduce((sum, segment) => sum + segment.text.length, 0),
    },
  };
}

function buildAnalyzerReductionInstructions(
  segments: ContextSegment[],
  config: TokenPilotClaudeCodeConfig,
): ClaudeReductionInstruction[] {
  const instructions: ClaudeReductionInstruction[] = [];
  if (config.reduction.passes.toolPayloadTrim) {
    const toolPayloadDecision = analyzeToolPayloadTrim(segments, {
      enabled: true,
      minChars: 120,
      minSavedChars: Math.max(300, Math.floor(config.reduction.maxToolChars * 0.25)),
      onlyLikelyToolSegments: false,
    });
    instructions.push(...toolPayloadDecision.instructions);
  }
  if (config.reduction.passes.execOutputTruncation) {
    const toolThresholds = config.reduction.passOptions.execOutputTruncation?.toolThresholds;
    const execDecision = analyzeExecOutputTruncation(segments, {
      enabled: true,
      toolThresholds: toolThresholds && typeof toolThresholds === "object"
        ? toolThresholds as Record<string, number>
        : {},
      minExcessChars: 1000,
    });
    instructions.push(...execDecision.instructions);
  }
  return instructions;
}

function buildFallbackReductionInstructions(
  segments: ContextSegment[],
  config: TokenPilotClaudeCodeConfig,
): ClaudeReductionInstruction[] {
  const instructions: ClaudeReductionInstruction[] = [];
  const toolPayloadByKind = new Map<string, ContextSegment[]>();
  const execSegmentIds: string[] = [];

  for (const segment of segments) {
    const meta = segment.metadata ?? {};
    const toolPayload = meta.toolPayload && typeof meta.toolPayload === "object"
      ? meta.toolPayload as Record<string, unknown>
      : {};
    const toolName = typeof toolPayload.toolName === "string" && toolPayload.toolName.trim()
      ? toolPayload.toolName.trim()
      : "tool";
    const payloadKind = typeof meta.payloadKind === "string" ? meta.payloadKind : payloadKindForText(segment.text);
    const isWebPayload = looksLikeWebPayload(segment.text);

    if (config.reduction.passes.toolPayloadTrim && segment.text.length >= (isWebPayload ? 120 : 200)) {
      const key = payloadKind === "json" || payloadKind === "stderr" || payloadKind === "blob" ? payloadKind : "stdout";
      const existing = toolPayloadByKind.get(key) ?? [];
      existing.push(segment);
      toolPayloadByKind.set(key, existing);
    }

    const execThreshold = thresholdForTool(toolName, config);
    if (
      config.reduction.passes.execOutputTruncation &&
      Number.isFinite(execThreshold) &&
      segment.text.length > execThreshold
    ) {
      execSegmentIds.push(segment.id);
    }
  }

  for (const [kind, kindSegments] of toolPayloadByKind) {
    const totalChars = kindSegments.reduce((sum, segment) => sum + segment.text.length, 0);
    const hasWebPayload = kindSegments.some((segment) => looksLikeWebPayload(segment.text));
    const minGroupChars = hasWebPayload
      ? Math.max(300, Math.floor(config.reduction.maxToolChars * 0.25))
      : Math.max(600, Math.floor(config.reduction.maxToolChars * 0.5));
    if (totalChars < minGroupChars) continue;
    instructions.push({
      strategy: "tool_payload_trim",
      segmentIds: kindSegments.map((segment) => segment.id),
      confidence: kind === "json" ? 0.9 : kind === "stdout" ? 0.8 : 0.75,
      priority: hasWebPayload ? 9 : 8,
      rationale: `Claude tool payload trim: ${kindSegments.length} ${kind} segment(s), ${totalChars} chars`,
      parameters: {
        payloadKind: kind,
        segmentCount: kindSegments.length,
        totalChars,
      },
    });
  }

  if (execSegmentIds.length > 0) {
    instructions.push({
      strategy: "exec_output_truncation",
      segmentIds: execSegmentIds,
      confidence: 0.99,
      priority: 10,
      rationale: `Claude large tool output truncation: ${execSegmentIds.length} segment(s)`,
    });
  }

  return instructions.sort((a, b) => b.priority - a.priority);
}

function dedupeReductionInstructions(instructions: ClaudeReductionInstruction[]): ClaudeReductionInstruction[] {
  const seen = new Set<string>();
  const result: ClaudeReductionInstruction[] = [];
  for (const instruction of instructions) {
    const key = `${instruction.strategy}:${[...instruction.segmentIds].sort().join(",")}:${JSON.stringify(instruction.parameters ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(instruction);
  }
  return result.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

function withReductionPolicy(
  turnCtx: RuntimeTurnContext,
  instructions: ClaudeReductionInstruction[],
): RuntimeTurnContext {
  if (instructions.length === 0) return turnCtx;
  const existingPolicy = turnCtx.metadata?.policy && typeof turnCtx.metadata.policy === "object"
    ? turnCtx.metadata.policy as Record<string, unknown>
    : {};
  const existingDecisions = existingPolicy.decisions && typeof existingPolicy.decisions === "object"
    ? existingPolicy.decisions as Record<string, unknown>
    : {};
  const existingReduction = existingDecisions.reduction && typeof existingDecisions.reduction === "object"
    ? existingDecisions.reduction as Record<string, unknown>
    : {};
  const existingInstructions = Array.isArray(existingReduction.instructions)
    ? existingReduction.instructions as unknown[]
    : [];
  return {
    ...turnCtx,
    metadata: {
      ...(turnCtx.metadata ?? {}),
      policy: {
        ...existingPolicy,
        decisions: {
          ...existingDecisions,
          reduction: {
            ...existingReduction,
            instructions: [...existingInstructions, ...instructions],
          },
        },
      },
    },
  };
}

function summarizePassEffects(report: ClaudeReductionReportEntry[]): ClaudeReductionPassEffect[] {
  return report.map((entry) => ({
    id: String(entry.id),
    changed: entry.changed,
    skippedReason: entry.skippedReason,
    note: entry.note,
    beforeChars: entry.beforeChars,
    afterChars: entry.afterChars,
    savedChars: Math.max(0, entry.beforeChars - entry.afterChars),
    touchedSegmentIds: entry.touchedSegmentIds,
  }));
}

function passOptionsFromConfig(config: TokenPilotClaudeCodeConfig): Record<string, Record<string, unknown>> {
  return {
    read_state_compaction: config.reduction.passOptions.readStateCompaction ?? {},
    tool_payload_trim: {
      maxChars: config.reduction.maxToolChars,
      ...(config.reduction.passOptions.toolPayloadTrim ?? {}),
    },
    html_slimming: config.reduction.passOptions.htmlSlimming ?? {},
    exec_output_truncation: config.reduction.passOptions.execOutputTruncation ?? {},
    agents_startup_optimization: config.reduction.passOptions.agentsStartupOptimization ?? {},
  };
}

function enabledPassIds(config: TokenPilotClaudeCodeConfig): Set<string> {
  const ids = new Set<string>();
  if (config.reduction.passes.readStateCompaction) ids.add("read_state_compaction");
  if (config.reduction.passes.toolPayloadTrim) ids.add("tool_payload_trim");
  if (config.reduction.passes.htmlSlimming) ids.add("html_slimming");
  if (config.reduction.passes.execOutputTruncation) ids.add("exec_output_truncation");
  if (config.reduction.passes.agentsStartupOptimization) ids.add("agents_startup_optimization");
  return ids;
}

export async function applyBeforeCallReductionToClaudePayload(params: {
  payload: any;
  sessionId: string;
  config: TokenPilotClaudeCodeConfig;
}): Promise<ClaudeReductionSummary> {
  const { payload, sessionId, config } = params;
  if (!config.modules.reduction || !Array.isArray(payload?.messages)) {
    return {
      changedMessages: 0,
      changedBlocks: 0,
      savedChars: 0,
      beforeChars: 0,
      afterChars: 0,
      report: [],
      passEffects: [],
      diagnostics: {
        messageCount: Array.isArray(payload?.messages) ? payload.messages.length : 0,
        toolLikeMessages: 0,
        candidateSegments: 0,
        candidateChars: 0,
      },
      skippedReason: !Array.isArray(payload?.messages) ? "no_messages_array" : "disabled",
    };
  }

  const snapshot = await loadClaudeCodeSessionSnapshot(config.stateDir, sessionId);
  const built = buildTurnContext(payload, sessionId, {
    disclosedReadPaths: normalizeDisclosedReadPaths(snapshot?.disclosedReadPaths),
  });
  const analyzerInstructions = buildAnalyzerReductionInstructions(built.turnCtx.segments, config);
  const fallbackInstructions = buildFallbackReductionInstructions(built.turnCtx.segments, config);
  const localInstructions = dedupeReductionInstructions([...analyzerInstructions, ...fallbackInstructions]);
  const turnCtx = withReductionPolicy(built.turnCtx, localInstructions);
  const { bindings } = built;
  const totalChars = turnCtx.segments.reduce((sum, segment) => sum + segment.text.length, 0);

  if (turnCtx.segments.length === 0 || totalChars < config.reduction.triggerMinChars) {
    return {
      changedMessages: 0,
      changedBlocks: 0,
      savedChars: 0,
      beforeChars: totalChars,
      afterChars: totalChars,
      report: [],
      passEffects: [],
      diagnostics: built.diagnostics,
      skippedReason: turnCtx.segments.length === 0 ? "no_candidate_segments" : "below_trigger_min_chars",
    };
  }

  const passOptions = passOptionsFromConfig(config);
  const enabled = enabledPassIds(config);
  const passes = resolveReductionPasses({
    maxToolChars: config.reduction.maxToolChars,
    passOptions,
  }).filter((pass) => pass.phase === "before_call" && enabled.has(pass.id));
  const { turnCtx: reducedCtx, report } = await runReductionBeforeCall({ turnCtx, passes });
  const passEffects = summarizePassEffects(report);
  const changedSegmentIds = new Set<string>();
  for (const entry of report) {
    if (!entry.changed) continue;
    for (const id of entry.touchedSegmentIds ?? []) changedSegmentIds.add(id);
  }

  if (changedSegmentIds.size === 0) {
    return {
      changedMessages: 0,
      changedBlocks: 0,
      savedChars: 0,
      beforeChars: totalChars,
      afterChars: totalChars,
      report,
      passEffects,
      diagnostics: built.diagnostics,
      disclosedReadPaths: normalizeDisclosedReadPaths(reducedCtx.metadata?.disclosedReadPaths),
      skippedReason: "pipeline_no_effect",
    };
  }

  const segmentMap = new Map(reducedCtx.segments.map((segment) => [segment.id, segment]));
  let changedBlocks = 0;
  let savedChars = 0;
  const changedMessages = new Set<number>();
  const visualSegments: ClaudeReductionVisualSegment[] = [];

  for (const binding of bindings) {
    if (!changedSegmentIds.has(binding.segmentId)) continue;
    const segment = segmentMap.get(binding.segmentId);
    if (!segment) continue;
    const message = payload.messages?.[binding.messageIndex];
    if (!message || typeof message !== "object") continue;

    let before = "";
    if (binding.blockIndex === undefined) {
      if (typeof message.content !== "string" || message.content === segment.text) continue;
      before = message.content;
      message.content = segment.text;
    } else {
      const block = Array.isArray(message.content) ? message.content[binding.blockIndex] : null;
      if (!block || typeof block !== "object") continue;
      if (typeof block[binding.field] !== "string" || block[binding.field] === segment.text) continue;
      before = block[binding.field];
      block[binding.field] = segment.text;
    }

    changedBlocks += 1;
    changedMessages.add(binding.messageIndex);
    const segmentSavedChars = Math.max(0, before.length - segment.text.length);
    savedChars += segmentSavedChars;
    visualSegments.push({
      segmentId: binding.segmentId,
      messageIndex: binding.messageIndex,
      field: binding.field,
      blockIndex: binding.blockIndex,
      toolName: binding.toolName,
      savedChars: segmentSavedChars,
      beforeText: before,
      afterText: segment.text,
      report: report.filter((entry) => entry.changed && entry.touchedSegmentIds?.includes(binding.segmentId)),
    });
  }

  return {
    changedMessages: changedMessages.size,
    changedBlocks,
    savedChars,
    beforeChars: totalChars,
    afterChars: Math.max(0, totalChars - savedChars),
    report,
    passEffects,
    diagnostics: built.diagnostics,
    visualSegments,
    disclosedReadPaths: normalizeDisclosedReadPaths(reducedCtx.metadata?.disclosedReadPaths),
  };
}

export async function reduceClaudeRequestEnvelope(params: {
  envelope: HostRequestEnvelope;
  codec: HostPayloadCodec;
  config: TokenPilotClaudeCodeConfig;
}): Promise<{
  envelope: HostRequestEnvelope;
  summary: ClaudeReductionSummary;
}> {
  const rawPayload = params.codec.encodeRequest(params.envelope) as any;
  const summary = await applyBeforeCallReductionToClaudePayload({
    payload: rawPayload,
    sessionId: params.envelope.session.sessionId,
    config: params.config,
  });
  if (summary.changedBlocks === 0) {
    return {
      envelope: params.envelope,
      summary,
    };
  }
  return {
    envelope: params.codec.decodeRequest(rawPayload),
    summary,
  };
}
