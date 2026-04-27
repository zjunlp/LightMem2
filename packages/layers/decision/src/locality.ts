import type { RuntimeTurnContext } from "@tokenpilot/kernel";
import type { PersistedMessageKind, PersistedMessageOrigin, PersistedMessageRole } from "@tokenpilot/kernel";

// Inlined from @ecoclaw/layer-context (being removed)
export type ContextViewMessageSnapshot = {
  messageId: string;
  branchId: string;
  parentMessageId?: string;
  role: PersistedMessageRole;
  kind: PersistedMessageKind;
  origin: PersistedMessageOrigin;
  content: string;
  createdAt: string;
  chars: number;
  approxTokens: number;
  source?: string;
  replacesMessageIds?: string[];
  derivedFromArtifactId?: string;
  metadata?: Record<string, unknown>;
};

type ContextViewBranchSnapshot = {
  branchId: string;
  parentBranchId?: string;
  forkedFromMessageId?: string;
  headMessageId?: string;
  createdAt: string;
  source: string;
  directMessageCount: number;
  replayMessageCount: number;
  syntheticMessageCount: number;
  observedMessageCount: number;
  lineageBranchIds: string[];
};

type ContextViewStats = {
  branchCount: number;
  messageCount: number;
  syntheticMessageCount: number;
  observedMessageCount: number;
  toolMessageCount: number;
  summaryMessageCount: number;
  checkpointSeedCount: number;
};

export type ContextViewSnapshot = {
  sessionId: string;
  activeBranchId?: string;
  meta: null;
  turnsCount: number;
  branchCount: number;
  messageCount: number;
  activeReplayChars: number;
  activeReplayTokens: number;
  activeReplayMessages: ContextViewMessageSnapshot[];
  branches: ContextViewBranchSnapshot[];
  stats: ContextViewStats;
};
import { createHash } from "node:crypto";

export type LocalitySignalScope = "session" | "branch" | "message";
export type LocalityActionHint =
  | "protect"
  | "reduction"
  | "summary"
  | "handoff"
  | "observe";
export type LocalitySignalConfidence = "low" | "medium" | "high";

export type PolicyLocalitySignalKind =
  | "content_type_prior"
  | "hard_loop_detected"
  | "subtask_boundary"
  | "error_detected"
  | "structural_payload_detected"
  | "repeated_read_detected"
  | (string & {});

export type PolicyLocalitySignalTargets = {
  messageIds?: string[];
  branchIds?: string[];
};

export type PolicyLocalitySignalEvidence = {
  role?: string;
  kind?: string;
  payloadKind?: string;
  strategy?: string;
  errorCode?: string;
  toolName?: string;
  consistentError?: boolean;
  repeats?: number;
  boundaryIndex?: number;
  similarityToPreviousUser?: number;
  transition?: boolean;
  completion?: boolean;
  // For repeated_read_detected signal
  readPath?: string;
  contentHash?: string;
  firstReadIndex?: number;
  delayTurns?: number;
};

export type PolicyLocalitySignalCost = {
  chars?: number;
  approxTokens?: number;
  messageCount?: number;
  prefixChars?: number;
  latestMessageChars?: number;
};

export type PolicyLocalitySignal = {
  id: string;
  kind: PolicyLocalitySignalKind;
  scope: LocalitySignalScope;
  score: number;
  confidence: LocalitySignalConfidence;
  actionHints: LocalityActionHint[];
  targets: PolicyLocalitySignalTargets;
  rationale: string;
  evidence?: PolicyLocalitySignalEvidence;
  cost?: PolicyLocalitySignalCost;
};

export type PolicyLocalityConfig = {
  enabled: boolean;
  hardLoopWindowMessages: number;
  hardLoopMinRepeats: number;
  structuralPayloadMinChars: number;
  errorMinChars: number;
  subtaskBoundaryMinMessages: number;
};

export type PolicyLocalityAnalysis = {
  enabled: boolean;
  source: "context_view" | "none";
  activeBranchId?: string;
  activeReplayMessageCount: number;
  activeReplayChars: number;
  activeReplayTokens: number;
  stablePrefixChars: number;
  stablePrefixShare: number;
  signalCount: number;
  dominantAction: LocalityActionHint | "mixed" | "observe";
  highLocalityMessageIds: string[];
  lowLocalityMessageIds: string[];
  protectedMessageIds: string[];
  protectedChars: number;
  summaryCandidateMessageIds: string[];
  summaryCandidateChars: number;
  reductionCandidateMessageIds: string[];
  reductionCandidateChars: number;
  handoffCandidateMessageIds: string[];
  handoffCandidateChars: number;
  errorCandidateMessageIds: string[];
  signals: PolicyLocalitySignal[];
  notes: string[];
};

const CHARS_PER_TOKEN = 4;
const TRANSITION_MARKERS = [
  /\b(next|switch|move on|follow-up|another task|new task|different task|now let's|let's now|continue with)\b/i,
  /(接下来|然后|下一步|换一个|另一个|继续做|切到|新任务|下一个)/,
];
const COMPLETION_MARKERS = [
  /\b(done|completed|finished|resolved|fixed|implemented|passed|ready)\b/i,
  /(完成了|搞定了|修好了|做好了|通过了|已经完成|可以了|结束了)/,
];
const ERROR_PATTERNS: Array<{ code: string; regex: RegExp }> = [
  { code: "path_not_found", regex: /(enoent|no such file|not found|cannot find|does not exist|404\b)/i },
  { code: "permission_denied", regex: /(permission denied|eacces|operation not permitted|forbidden|unauthorized)/i },
  { code: "timeout", regex: /(timed out|timeout|deadline exceeded|context deadline exceeded)/i },
  { code: "exception", regex: /(traceback|exception|stack trace|panic:|runtime error)/i },
  { code: "command_failed", regex: /(command failed|non-zero exit|exit code\s*[:=]?\s*\d+|failed with status)/i },
  { code: "invalid_request", regex: /(invalid request|bad request|validation failed|schema error|parse error)/i },
];

type StructuralPayloadInfo = {
  kind: "html" | "json" | "xml" | "stderr" | "stdout" | "blob";
  strategy: string;
  confidence: LocalitySignalConfidence;
};

type ErrorInfo = {
  code: string;
  severity: LocalitySignalConfidence;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / CHARS_PER_TOKEN));
}

function messageCost(message: ContextViewMessageSnapshot): PolicyLocalitySignalCost {
  return {
    chars: message.chars,
    approxTokens: message.approxTokens,
  };
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))];
}

function readContextViewSnapshot(metadata?: Record<string, unknown>): ContextViewSnapshot | undefined {
  const raw = asRecord(metadata?.contextView);
  const activeReplayMessages = Array.isArray(raw?.activeReplayMessages)
    ? raw?.activeReplayMessages
    : undefined;
  if (!raw || !Array.isArray(activeReplayMessages)) return undefined;
  return raw as unknown as ContextViewSnapshot;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeForSignature(text: string): string {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\/tmp\/[^\s"'`]+/g, "<path>")
    .replace(/\/home\/[^\s"'`]+/g, "<path>")
    .slice(0, 360);
}

function tokenize(text: string): Set<string> {
  return new Set((normalizeForSignature(text).match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((token) => token.length > 1));
}

function jaccardSimilarity(left: string, right: string): number {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

function messageMap(messages: ContextViewMessageSnapshot[]): Map<string, ContextViewMessageSnapshot> {
  return new Map(messages.map((message) => [message.messageId, message]));
}

function sumMessageChars(messageIds: string[], messagesById: Map<string, ContextViewMessageSnapshot>): number {
  return uniqueStrings(messageIds).reduce((sum, messageId) => sum + (messagesById.get(messageId)?.chars ?? 0), 0);
}

function dominantAction(signals: PolicyLocalitySignal[]): LocalityActionHint | "mixed" | "observe" {
  if (signals.length === 0) return "observe";
  const weights = new Map<LocalityActionHint, number>();
  for (const signal of signals) {
    for (const hint of signal.actionHints) {
      weights.set(hint, (weights.get(hint) ?? 0) + Math.max(0.1, signal.score));
    }
  }
  const ranked = [...weights.entries()].sort((left, right) => right[1] - left[1]);
  if (ranked.length === 0) return "observe";
  if (ranked.length > 1 && Math.abs(ranked[0][1] - ranked[1][1]) < 0.05) return "mixed";
  return ranked[0][0];
}

function readPayloadKind(message: ContextViewMessageSnapshot): string | undefined {
  const metadata = asRecord(message.metadata);
  const toolPayload = asRecord(metadata?.toolPayload);
  const reduction = asRecord(metadata?.reduction);
  const trim = asRecord(reduction?.toolPayloadTrim);
  const candidates = [metadata?.payloadKind, toolPayload?.kind, reduction?.payloadKind, trim?.kind];
  const match = candidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  return typeof match === "string" ? match.trim().toLowerCase() : undefined;
}

function readToolName(message: ContextViewMessageSnapshot): string | undefined {
  const metadata = asRecord(message.metadata);
  const toolPayload = asRecord(metadata?.toolPayload);
  const candidates = [metadata?.toolName, toolPayload?.toolName];
  const match = candidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  return typeof match === "string" ? match.trim() : undefined;
}

function detectStructuralPayload(message: ContextViewMessageSnapshot): StructuralPayloadInfo | undefined {
  const payloadKind = readPayloadKind(message);
  if (payloadKind === "html") {
    return { kind: "html", strategy: "html_nav_core_only", confidence: "high" };
  }
  if (payloadKind === "json") {
    return { kind: "json", strategy: "json_shape_only", confidence: "high" };
  }
  if (payloadKind === "blob") {
    return { kind: "blob", strategy: "blob_stub_only", confidence: "high" };
  }
  if (payloadKind === "stdout") {
    return { kind: "stdout", strategy: "stdout_key_lines_only", confidence: "medium" };
  }
  if (payloadKind === "stderr") {
    return { kind: "stderr", strategy: "stderr_key_lines_only", confidence: "medium" };
  }

  const text = message.content.trim();
  if (!text) return undefined;
  if (/^\s*[\[{]/.test(text) && /[":][^\n]{0,120}/.test(text)) {
    return { kind: "json", strategy: "json_shape_only", confidence: "medium" };
  }
  if (/<\?xml|<svg\b|<rss\b|<feed\b/i.test(text)) {
    return { kind: "xml", strategy: "xml_core_nodes_only", confidence: "medium" };
  }
  if (/<(html|body|head|div|span|section|article|main|script|style|a|img)\b/i.test(text) || /<\/[a-z][\w:-]*>/i.test(text)) {
    return { kind: "html", strategy: "html_nav_core_only", confidence: "medium" };
  }
  if (/^data:[^;]+;base64,/i.test(text) || /[A-Za-z0-9+/]{200,}={0,2}/.test(text)) {
    return { kind: "blob", strategy: "blob_stub_only", confidence: "medium" };
  }
  if (/(^|\n)\s*stderr\s*[:=-]/i.test(text)) {
    return { kind: "stderr", strategy: "stderr_key_lines_only", confidence: "medium" };
  }
  if (/(^|\n)\s*stdout\s*[:=-]/i.test(text)) {
    return { kind: "stdout", strategy: "stdout_key_lines_only", confidence: "medium" };
  }
  return undefined;
}

function isLikelyToolLikeMessage(
  message: ContextViewMessageSnapshot,
  structuralPayload?: StructuralPayloadInfo,
): boolean {
  if (message.role === "tool") return true;
  if (message.kind === "context_snapshot" || message.kind === "reduction") return true;
  if (readPayloadKind(message)) return true;
  if (readToolName(message)) return true;
  return structuralPayload != null && ["html", "json", "xml", "stderr", "stdout", "blob"].includes(structuralPayload.kind);
}

function detectErrorInfo(
  message: ContextViewMessageSnapshot,
  structuralPayload?: StructuralPayloadInfo,
): ErrorInfo | undefined {
  const haystack = message.content;
  let code: string | undefined;
  for (const detector of ERROR_PATTERNS) {
    if (detector.regex.test(haystack)) {
      code = detector.code;
      break;
    }
  }
  if (!code) return undefined;
  const toolLike = isLikelyToolLikeMessage(message, structuralPayload);
  if (!toolLike && message.chars < 24 && !/(404|enoent|eacces)/i.test(haystack)) {
    return undefined;
  }
  return {
    code,
    severity: toolLike || structuralPayload?.kind === "stderr" ? "high" : "medium",
  };
}

function findLastIndex<T>(items: T[], predicate: (value: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return index;
  }
  return -1;
}

function contentTypeProtectScore(message: ContextViewMessageSnapshot, isTailConversation: boolean): number {
  if (message.kind === "summary" || message.kind === "checkpoint_seed" || message.kind === "handoff") {
    return 0.95;
  }
  if (message.role === "system") {
    return 0.9;
  }
  if (isTailConversation) {
    return 0.72;
  }
  return 0.82;
}

function contentTypeReductionScore(
  message: ContextViewMessageSnapshot,
  structuralPayload?: StructuralPayloadInfo,
): number {
  if (structuralPayload?.kind === "html" || structuralPayload?.kind === "json" || structuralPayload?.kind === "xml") {
    return 0.82;
  }
  if (structuralPayload?.kind === "blob") {
    return 0.88;
  }
  if (structuralPayload?.kind === "stderr" || structuralPayload?.kind === "stdout") {
    return 0.74;
  }
  if (message.role === "tool" || message.kind === "context_snapshot") {
    return 0.76;
  }
  if (readPayloadKind(message) || readToolName(message)) {
    return 0.7;
  }
  return 0.62;
}

function structuralPayloadScore(payload: StructuralPayloadInfo): number {
  switch (payload.kind) {
    case "blob":
      return 0.93;
    case "html":
    case "json":
    case "xml":
      return 0.87;
    case "stderr":
    case "stdout":
      return 0.78;
    default:
      return payload.confidence === "high" ? 0.84 : 0.72;
  }
}

function buildContentTypePriorSignals(messages: ContextViewMessageSnapshot[]): PolicyLocalitySignal[] {
  const signals: PolicyLocalitySignal[] = [];
  const tailConversationIds = new Set(
    messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-2)
      .map((message) => message.messageId),
  );

  for (const message of messages) {
    const structuralPayload = detectStructuralPayload(message);
    if (
      message.role === "system" ||
      message.kind === "summary" ||
      message.kind === "checkpoint_seed" ||
      message.kind === "handoff" ||
      tailConversationIds.has(message.messageId)
    ) {
      signals.push({
        id: `content-protect:${message.messageId}`,
        kind: "content_type_prior",
        scope: "message",
        score: contentTypeProtectScore(message, tailConversationIds.has(message.messageId)),
        confidence:
          message.kind === "summary" || message.kind === "checkpoint_seed" || message.kind === "handoff"
            ? "high"
            : "medium",
        actionHints: ["protect"],
        targets: { messageIds: [message.messageId] },
        rationale: "message type suggests high future reuse or active-task relevance",
        evidence: {
          role: message.role,
          kind: message.kind,
        },
        cost: messageCost(message),
      });
      continue;
    }

    if (isLikelyToolLikeMessage(message, structuralPayload)) {
      signals.push({
        id: `content-reduce:${message.messageId}`,
        kind: "content_type_prior",
        scope: "message",
        score: contentTypeReductionScore(message, structuralPayload),
        confidence: "medium",
        actionHints: ["reduction"],
        targets: { messageIds: [message.messageId] },
        rationale: "message type is tool-like or artifact-heavy and usually decays quickly in locality",
        evidence: {
          role: message.role,
          kind: message.kind,
        },
        cost: messageCost(message),
      });
    }
  }

  return signals;
}

function buildStructuralPayloadSignals(
  messages: ContextViewMessageSnapshot[],
  cfg: PolicyLocalityConfig,
): PolicyLocalitySignal[] {
  const signals: PolicyLocalitySignal[] = [];
  for (const message of messages) {
    if (message.chars < cfg.structuralPayloadMinChars) continue;
    const payload = detectStructuralPayload(message);
    if (!payload) continue;
    signals.push({
      id: `structural:${message.messageId}`,
      kind: "structural_payload_detected",
      scope: "message",
      score: structuralPayloadScore(payload),
      confidence: payload.confidence,
      actionHints: ["reduction"],
      targets: { messageIds: [message.messageId] },
      rationale: `structured ${payload.kind} payload can be aggressively pruned while retaining navigational or error-critical fields`,
      evidence: {
        payloadKind: payload.kind,
        strategy: payload.strategy,
      },
      cost: messageCost(message),
    });
  }
  return signals;
}

function buildErrorSignals(messages: ContextViewMessageSnapshot[], cfg: PolicyLocalityConfig): PolicyLocalitySignal[] {
  const signals: PolicyLocalitySignal[] = [];
  for (const message of messages) {
    if (message.chars < cfg.errorMinChars && message.role !== "tool" && message.kind !== "context_snapshot") {
      continue;
    }
    const structuralPayload = detectStructuralPayload(message);
    const errorInfo = detectErrorInfo(message, structuralPayload);
    if (!errorInfo) continue;
    const toolLike = isLikelyToolLikeMessage(message, structuralPayload);
    const actionHints: LocalityActionHint[] = toolLike ? ["summary", "reduction"] : ["summary"];
    signals.push({
      id: `error:${message.messageId}`,
      kind: "error_detected",
      scope: "message",
      score: errorInfo.severity === "high" ? 0.9 : 0.72,
      confidence: errorInfo.severity,
      actionHints,
      targets: { messageIds: [message.messageId] },
      rationale: "message looks like a failed attempt or invalid state and should be pruned with a minimal retained error report",
      evidence: {
        errorCode: errorInfo.code,
        role: message.role,
        kind: message.kind,
      },
      cost: messageCost(message),
    });
  }
  return signals;
}

function buildHardLoopSignals(messages: ContextViewMessageSnapshot[], cfg: PolicyLocalityConfig): PolicyLocalitySignal[] {
  const recent = messages.slice(-cfg.hardLoopWindowMessages);
  const groups = new Map<
    string,
    Array<{
      message: ContextViewMessageSnapshot;
      toolName?: string;
      errorCode?: string;
      toolLike: boolean;
    }>
  >();

  for (const message of recent) {
    const structuralPayload = detectStructuralPayload(message);
    const toolLike = isLikelyToolLikeMessage(message, structuralPayload);
    const errorInfo = detectErrorInfo(message, structuralPayload);
    if (!toolLike && !errorInfo) continue;
    const toolName = readToolName(message);
    const payloadKind = readPayloadKind(message) ?? structuralPayload?.kind ?? "text";
    const signature = `${toolName ?? "anon"}|${payloadKind}|${normalizeForSignature(message.content)}`;
    const bucket = groups.get(signature) ?? [];
    bucket.push({ message, toolName, errorCode: errorInfo?.code, toolLike });
    groups.set(signature, bucket);
  }

  const signals: PolicyLocalitySignal[] = [];
  for (const [signature, bucket] of groups.entries()) {
    if (bucket.length < cfg.hardLoopMinRepeats) continue;
    const messageIds = bucket.map((entry) => entry.message.messageId);
    const totalChars = bucket.reduce((sum, entry) => sum + entry.message.chars, 0);
    const totalTokens = bucket.reduce((sum, entry) => sum + entry.message.approxTokens, 0);
    const consistentError = uniqueStrings(bucket.map((entry) => entry.errorCode ?? "none")).length <= 1;
    const allToolLike = bucket.every((entry) => entry.toolLike);
    const toolName = bucket.find((entry) => entry.toolName)?.toolName;
    const actionHints: LocalityActionHint[] = allToolLike
      ? ["summary", "handoff", "reduction"]
      : ["summary", "handoff"];
    signals.push({
      id: `hard-loop:${signature.slice(0, 64)}`,
      kind: "hard_loop_detected",
      scope: "branch",
      score: Math.min(0.99, 0.55 + bucket.length * 0.16),
      confidence: consistentError ? "high" : "medium",
      actionHints,
      targets: { messageIds },
      rationale:
        "recent messages repeat the same tool-like signature and outcome, indicating progress stall rather than forward motion",
      evidence: {
        repeats: bucket.length,
        toolName: toolName ?? "",
        consistentError,
      },
      cost: {
        chars: totalChars,
        approxTokens: totalTokens,
        messageCount: bucket.length,
        latestMessageChars: bucket[bucket.length - 1]?.message.chars ?? 0,
      },
    });
  }
  return signals;
}

function hasTransitionMarker(text: string): boolean {
  return TRANSITION_MARKERS.some((pattern) => pattern.test(text));
}

function hasCompletionMarker(text: string): boolean {
  return COMPLETION_MARKERS.some((pattern) => pattern.test(text));
}

function buildSubtaskBoundarySignals(
  messages: ContextViewMessageSnapshot[],
  cfg: PolicyLocalityConfig,
  activeBranchId?: string,
): PolicyLocalitySignal[] {
  if (messages.length < cfg.subtaskBoundaryMinMessages) return [];

  let best:
    | {
        index: number;
        score: number;
        similarity: number;
        transition: boolean;
        completion: boolean;
        prefixChars: number;
        prefixMessageIds: string[];
      }
    | undefined;

  for (let index = 1; index < messages.length; index += 1) {
    const current = messages[index];
    if (current.role !== "user") continue;
    const prefix = messages.slice(0, index);
    if (prefix.length < cfg.subtaskBoundaryMinMessages) continue;

    const previousUserIndex = findLastIndex(prefix, (message) => message.role === "user");
    if (previousUserIndex < 0) continue;

    const previousUser = prefix[previousUserIndex];
    const between = messages.slice(previousUserIndex + 1, index);
    if (!between.some((message) => message.role === "assistant" || message.role === "tool")) continue;

    const similarity = jaccardSimilarity(previousUser.content, current.content);
    const transition = hasTransitionMarker(current.content);
    const completion = between.some((message) => hasCompletionMarker(message.content) || message.role === "tool");
    const prefixMessageIds = prefix
      .filter((message) => !["summary", "checkpoint_seed", "handoff"].includes(message.kind))
      .map((message) => message.messageId);
    const prefixChars = prefix.reduce((sum, message) => sum + message.chars, 0);

    let score = 0.2;
    score += between.length > 0 ? 0.2 : 0;
    score += transition ? 0.25 : 0;
    if (similarity < 0.18) score += 0.25;
    else if (similarity < 0.32) score += 0.12;
    score += completion ? 0.15 : 0;

    if (score < 0.6 || prefixMessageIds.length === 0) continue;
    if (!best || score > best.score || (score === best.score && index > best.index)) {
      best = {
        index,
        score,
        similarity,
        transition,
        completion,
        prefixChars,
        prefixMessageIds,
      };
    }
  }

  if (!best) return [];
  const actionHints: LocalityActionHint[] = ["summary"];
  if (best.score >= 0.8) {
    actionHints.push("handoff");
  }

  return [
    {
      id: `subtask-boundary:${messages[best.index]?.messageId ?? best.index}`,
      kind: "subtask_boundary",
      scope: "branch",
      score: Math.min(0.98, best.score),
      confidence: best.score >= 0.8 ? "high" : "medium",
      actionHints,
      targets: {
        messageIds: best.prefixMessageIds,
        branchIds: activeBranchId ? [activeBranchId] : [],
      },
      rationale:
        "conversation shows a transition into a new subtask, so the earlier completed prefix is a candidate for summary or branch-level checkpointing",
      evidence: {
        boundaryIndex: best.index,
        similarityToPreviousUser: Number(best.similarity.toFixed(3)),
        transition: best.transition,
        completion: best.completion,
      },
      cost: {
        chars: best.prefixChars,
        approxTokens: estimateTokens(best.prefixChars),
        messageCount: best.prefixMessageIds.length,
        prefixChars: best.prefixChars,
      },
    },
  ];
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function readReadPath(message: ContextViewMessageSnapshot): string | undefined {
  const metadata = asRecord(message.metadata);
  const toolPayload = asRecord(metadata?.toolPayload);
  const candidates = [toolPayload?.path, toolPayload?.file_path, metadata?.path, metadata?.file_path];
  const match = candidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  return typeof match === "string" ? match.trim() : undefined;
}

function collectMessageTargets(
  signals: PolicyLocalitySignal[],
  hint: LocalityActionHint,
): string[] {
  return uniqueStrings(
    signals
      .filter((signal) => signal.actionHints.includes(hint))
      .flatMap((signal) => signal.targets.messageIds ?? []),
  );
}

function collectBranchTargets(
  signals: PolicyLocalitySignal[],
  hint: LocalityActionHint,
): string[] {
  return uniqueStrings(
    signals
      .filter((signal) => signal.actionHints.includes(hint))
      .flatMap((signal) => signal.targets.branchIds ?? []),
  );
}

export function analyzePolicyLocality(params: {
  ctx: RuntimeTurnContext;
  cfg: PolicyLocalityConfig;
}): PolicyLocalityAnalysis {
  const { ctx, cfg } = params;
  const stablePrefixChars = ctx.segments
    .filter((segment) => segment.kind === "stable")
    .reduce((sum, segment) => sum + segment.text.length, 0);
  const totalSegmentChars = ctx.segments.reduce((sum, segment) => sum + segment.text.length, 0);
  const stablePrefixShare = totalSegmentChars > 0 ? stablePrefixChars / totalSegmentChars : 0;

  const empty: PolicyLocalityAnalysis = {
    enabled: cfg.enabled,
    source: "none",
    activeReplayMessageCount: 0,
    activeReplayChars: 0,
    activeReplayTokens: 0,
    stablePrefixChars,
    stablePrefixShare,
    signalCount: 0,
    dominantAction: "observe",
    highLocalityMessageIds: [],
    lowLocalityMessageIds: [],
    protectedMessageIds: [],
    protectedChars: 0,
    summaryCandidateMessageIds: [],
    summaryCandidateChars: 0,
    reductionCandidateMessageIds: [],
    reductionCandidateChars: 0,
    handoffCandidateMessageIds: [],
    handoffCandidateChars: 0,
    errorCandidateMessageIds: [],
    signals: [],
    notes: cfg.enabled ? ["context_view_unavailable"] : ["locality_disabled"],
  };
  if (!cfg.enabled) return empty;

  const contextView = readContextViewSnapshot(ctx.metadata);
  if (!contextView) return empty;

  const messages = contextView.activeReplayMessages ?? [];
  const signals: PolicyLocalitySignal[] = [];
  signals.push(...buildContentTypePriorSignals(messages));
  signals.push(...buildStructuralPayloadSignals(messages, cfg));
  signals.push(...buildErrorSignals(messages, cfg));
  signals.push(...buildHardLoopSignals(messages, cfg));
  signals.push(...buildSubtaskBoundarySignals(messages, cfg, contextView.activeBranchId));

  const messagesById = messageMap(messages);
  const protectedMessageIds = collectMessageTargets(signals, "protect");
  const reductionCandidateMessageIds = collectMessageTargets(signals, "reduction").filter(
    (messageId) => !protectedMessageIds.includes(messageId),
  );
  const summaryCandidateMessageIds = collectMessageTargets(signals, "summary").filter(
    (messageId) => !protectedMessageIds.includes(messageId),
  );
  const handoffCandidateMessageIds = collectMessageTargets(signals, "handoff").filter(
    (messageId) => !protectedMessageIds.includes(messageId),
  );
  const errorCandidateMessageIds = uniqueStrings(
    signals
      .filter((signal) => signal.kind === "error_detected")
      .flatMap((signal) => signal.targets.messageIds ?? []),
  );

  const protectedChars = sumMessageChars(protectedMessageIds, messagesById);
  const summaryCandidateChars = sumMessageChars(summaryCandidateMessageIds, messagesById);
  const reductionCandidateChars = sumMessageChars(reductionCandidateMessageIds, messagesById);
  const handoffCandidateChars = sumMessageChars(handoffCandidateMessageIds, messagesById);
  const activeReplayChars = messages.reduce((sum, message) => sum + message.chars, 0);
  const activeReplayTokens = messages.reduce((sum, message) => sum + message.approxTokens, 0);

  const signalKindCounts = new Map<string, number>();
  for (const signal of signals) {
    signalKindCounts.set(signal.kind, (signalKindCounts.get(signal.kind) ?? 0) + 1);
  }

  return {
    enabled: cfg.enabled,
    source: "context_view",
    activeBranchId: contextView.activeBranchId,
    activeReplayMessageCount: messages.length,
    activeReplayChars,
    activeReplayTokens,
    stablePrefixChars,
    stablePrefixShare,
    signalCount: signals.length,
    dominantAction: dominantAction(signals),
    highLocalityMessageIds: protectedMessageIds,
    lowLocalityMessageIds: uniqueStrings([
      ...reductionCandidateMessageIds,
      ...summaryCandidateMessageIds,
      ...handoffCandidateMessageIds,
    ]),
    protectedMessageIds,
    protectedChars,
    summaryCandidateMessageIds,
    summaryCandidateChars,
    reductionCandidateMessageIds,
    reductionCandidateChars,
    handoffCandidateMessageIds,
    handoffCandidateChars,
    errorCandidateMessageIds,
    signals,
    notes: [
      `active_replay_messages=${messages.length}`,
      `active_replay_chars=${activeReplayChars}`,
      `stable_prefix_chars=${stablePrefixChars}`,
      ...[...signalKindCounts.entries()].map(([kind, count]) => `signal.${kind}=${count}`),
    ],
  };
}
