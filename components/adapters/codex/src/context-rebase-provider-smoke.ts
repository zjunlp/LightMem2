import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reserveUnusedPort } from "@lightmem2/host-adapter";

import { normalizeTokenPilotCodexConfig } from "./config.js";
import {
  buildCodexEffectiveHistory,
  loadCodexContextHistoryJournal,
  type CodexContextHistoryJournalEntry,
  type JsonObject,
} from "./context-history/index.js";
import type { TokenPilotCodexLogger } from "./logger.js";
import { startCodexResponsesProxy, type CodexProxyRuntime } from "./proxy-runtime.js";
import {
  CODEX_REBASE_API_VERSION,
  CODEX_REBASE_ITEM_SCHEMA_VERSION,
  CODEX_REBASE_WIRE_MODE,
  readCodexRebaseCapabilityJournal,
  readLatestCodexRebaseEpoch,
} from "./context-rewrite/index.js";
import type { CodexRebaseAccounting } from "./context-rewrite/types.js";
import { resolveCodexSessionIdByResponseId } from "./session-state.js";

export const CODEX_REBASE_PROVIDER_SMOKE_EVIDENCE_SCHEMA =
  "lightmem2.codex.context-rebase-provider-smoke-evidence/v2";
const PROVIDER_SMOKE_MAX_OUTPUT_TOKENS = 2_048;

export type ProviderUsageObservation = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ProviderUsageTurnComparison = {
  turn: number;
  baselineInputTokens: number;
  rebaseInputTokens: number;
  savedInputTokens: number;
  cumulativeSavedInputTokens: number;
  baselineCachedInputTokens: number;
  rebaseCachedInputTokens: number;
};

export type ProviderUsageEvidence = {
  source: "provider-response-usage";
  comparableSetup: boolean;
  setup: {
    baseline: ProviderUsageObservation[];
    rebase: ProviderUsageObservation[];
  };
  continuationTurns: ProviderUsageTurnComparison[];
  observedBreakEvenTurn?: number;
  projectedBreakEvenTurn?: number;
  rebaseTurnOverheadTokens: number;
  observedSavedInputTokens: number;
  subsequentSavedInputTokensPerTurn: number;
};

export type ProviderCompatibilityMatrixEntry = {
  itemType: string;
  structuralPolicy: "transport" | "replay-candidate" | "closure-required" | "exact-payload" | "deferred";
  providerDecision: "real-pass" | "real-reject" | "mock" | "not-observed";
  evidence: "real-provider" | "mock-fixture" | "none";
  reason: string;
};

export type CodexRebaseProviderSmokeEvidence = {
  schema: typeof CODEX_REBASE_PROVIDER_SMOKE_EVIDENCE_SCHEMA;
  mode: "provider";
  provider: "openai-compatible";
  endpoint: {
    host: string;
    sha256: string;
  };
  model: string;
  protocol: {
    wireMode: typeof CODEX_REBASE_WIRE_MODE;
    apiVersion: typeof CODEX_REBASE_API_VERSION;
    itemSchemaVersion: typeof CODEX_REBASE_ITEM_SCHEMA_VERSION;
  };
  runtime: {
    node: string;
    codexCli: string;
  };
  startedAt: string;
  finishedAt: string;
  capability: {
    responsesEndpointAccepted: boolean;
    reasoningItemPresent: boolean;
    encryptedReasoningPresent: boolean;
    encryptedPayloadChars: number;
    encryptedPayloadSha256: string;
    toolCallPresent: boolean;
    journalTrusted: boolean;
    realProviderVerifiedItemTypes: string[];
    realProviderRejectedItemTypes: string[];
  };
  compatibilityMatrix: ProviderCompatibilityMatrixEntry[];
  rebase: {
    committed: boolean;
    oldChainReferenceRemoved: boolean;
    currentInputOccurrences: number;
    sentinel: {
      evictedAbsent: boolean;
      retainedPresent: boolean;
    };
    replayItemTypes: string[];
    encryptedPayloadDigestMatches: boolean;
    toolClosure: {
      callCount: number;
      outputCount: number;
      complete: boolean;
    };
    responseChain: {
      newRootPresent: boolean;
      terminalPresent: boolean;
      terminalSessionMappingMatches: boolean;
      journalCommittedBeforeEpoch: boolean;
      continuationTurns: number;
      linksValid: boolean;
      restartPreserved: boolean;
      finalHistoryComplete: boolean;
    };
    estimatorAccounting?: CodexRebaseAccounting;
  };
  controlledFailureCoverage: {
    source: "mock-automation";
    fallbackAtMostOnce: true;
    transientDoesNotPoisonCapability: true;
    payloadRejectionScopedByDigest: true;
    cooldownPreventsImmediateRetry: true;
  };
  usage: ProviderUsageEvidence;
  privacy: {
    credentialSource: "OPENAI_API_KEY";
    baseUrlSource: "OPENAI_BASE_URL-or-cli";
    rawPromptPersisted: false;
    rawEncryptedPayloadPersisted: false;
    rawResponseIdPersisted: false;
    rawHeadersPersisted: false;
    rawProviderErrorPersisted: false;
    ephemeralStateRemoved: true;
  };
};

export type RunCodexRebaseProviderSmokeOptions = {
  baseUrl: string;
  model?: string;
  outputDir?: string;
  continuationTurns?: number;
};

export type CodexRebaseProviderSmokeRunResult = {
  artifactPath: string;
  artifactSha256: string;
  evidence: CodexRebaseProviderSmokeEvidence;
};

type ProviderConversationResult = {
  setupUsage: ProviderUsageObservation[];
  continuationUsage: ProviderUsageObservation[];
};

async function replayDiagnostic(params: {
  stateDir: string;
  sessionId: string;
  headResponseId: string;
}): Promise<string> {
  try {
    const history = await buildCodexEffectiveHistory(params);
    const deferredTypes = Array.from(new Set(history.deferredItems.map((entry) => (
      typeof entry.item.type === "string" ? entry.item.type : "unknown"
    )))).sort();
    return [
      `source=${history.source}`,
      `incomplete=${history.incomplete}`,
      `deferred=${deferredTypes.join(",") || "none"}`,
      `unresolved=${history.unresolvedCallIds.length}`,
    ].join(";");
  } catch {
    return "history-diagnostic-unavailable";
  }
}

type ProviderRebaseResult = ProviderConversationResult & {
  capability: CodexRebaseProviderSmokeEvidence["capability"];
  compatibilityMatrix: ProviderCompatibilityMatrixEntry[];
  rebase: CodexRebaseProviderSmokeEvidence["rebase"];
};

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
  531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6697, 10080,
]);

const silentLogger: TokenPilotCodexLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function credentialShaped(value: string): boolean {
  return /(?:\b(?:bearer|api[_-]?key|access[_-]?token|secret|authorization)\b|sk-[a-z0-9_-]{12,}|(?:github_pat_|gh[pousr]_)[a-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|(?:xapp-|xox[baprsuv]-)[a-z0-9-]{10,}|tvly-[a-z0-9-]{12,}|[?&](?:key|token|signature)=)/iu.test(value);
}

export function sanitizedEvidenceLabel(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 160 && !credentialShaped(trimmed)
    ? trimmed
    : "not-observed";
}

function responseChainLinksValid(params: {
  journal: CodexContextHistoryJournalEntry[];
  rootResponseId: string;
  expectedPreviousIds: string[];
  terminalResponseId: string;
}): boolean {
  const requests = new Map<string, Extract<CodexContextHistoryJournalEntry, { kind: "request" }>>();
  const responses = new Map<string, Extract<CodexContextHistoryJournalEntry, { kind: "response" }>>();
  for (const entry of params.journal) {
    if (entry.kind === "request" && entry.status === "completed") requests.set(entry.requestId, entry);
    if (entry.kind === "response" && entry.responseId && entry.status === "completed") {
      responses.set(entry.responseId, entry);
    }
  }

  let previousResponseId = params.rootResponseId;
  for (const expectedPreviousId of params.expectedPreviousIds) {
    if (expectedPreviousId !== previousResponseId) return false;
    const matchingRequests = Array.from(requests.values()).filter((entry) => (
      entry.previousResponseId === expectedPreviousId
    ));
    if (matchingRequests.length !== 1) return false;
    const request = matchingRequests[0]!;
    const matchingResponses = Array.from(responses.values()).filter((entry) => (
      entry.requestId === request.requestId
      && entry.previousResponseId === expectedPreviousId
    ));
    if (matchingResponses.length !== 1) return false;
    previousResponseId = matchingResponses[0]!.responseId!;
  }
  return previousResponseId === params.terminalResponseId;
}

function jsonItems(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function numericField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function usageObservation(response: JsonObject): ProviderUsageObservation {
  const usage = response.usage && typeof response.usage === "object" && !Array.isArray(response.usage)
    ? response.usage as JsonObject
    : {};
  const details = usage.input_tokens_details
    && typeof usage.input_tokens_details === "object"
    && !Array.isArray(usage.input_tokens_details)
    ? usage.input_tokens_details as JsonObject
    : {};
  return {
    inputTokens: numericField(usage.input_tokens),
    cachedInputTokens: numericField(details.cached_tokens),
    outputTokens: numericField(usage.output_tokens),
    totalTokens: numericField(usage.total_tokens),
  };
}

function responseId(response: JsonObject, phase: string): string {
  if (typeof response.id !== "string" || !response.id) {
    throw new Error(`Provider smoke ${phase} did not return a response id`);
  }
  if (response.status && response.status !== "completed") {
    throw new Error(`Provider smoke ${phase} returned a non-completed response`);
  }
  return response.id;
}

function toolClosureEvidence(input: JsonObject[]): {
  callCount: number;
  outputCount: number;
  complete: boolean;
} {
  const calls = input.filter((item) => item.type === "function_call");
  const outputs = input.filter((item) => item.type === "function_call_output");
  const callIds = calls.map((item) => item.call_id).filter((value): value is string => typeof value === "string");
  const outputIds = outputs.map((item) => item.call_id).filter((value): value is string => typeof value === "string");
  return {
    callCount: calls.length,
    outputCount: outputs.length,
    complete: callIds.length === calls.length
      && outputIds.length === outputs.length
      && new Set(callIds).size === callIds.length
      && new Set(outputIds).size === outputIds.length
      && callIds.length === outputIds.length
      && callIds.every((callId) => outputIds.includes(callId)),
  };
}

async function reserveFetchPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await reserveUnusedPort();
    if (!FETCH_FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("Unable to reserve a fetch-safe provider smoke port");
}

function buildProviderSmokeConfig(params: {
  stateDir: string;
  proxyPort: number;
  upstreamBaseUrl: string;
  rewriteEnabled: boolean;
}) {
  return normalizeTokenPilotCodexConfig({
    stateDir: params.stateDir,
    proxyPort: params.proxyPort,
    upstreamProvider: "provider-smoke",
    upstream: {
      name: "openai-compatible",
      baseUrl: params.upstreamBaseUrl,
      wireApi: "responses",
      requiresOpenAIAuth: true,
    },
    modules: { stabilizer: false, reduction: false },
    contextRewrite: {
      enabled: params.rewriteEnabled,
      providerCompatibilityProbe: "real_provider",
      mode: "response_chain_rebase",
      failureMode: "bypass",
      retryOriginalRequest: true,
      cooldownMs: 300_000,
      mutationPlan: { operations: [] },
    },
  });
}

function sanitizedProviderFailure(response: Response, text: string, phase: string): Error {
  let code = "unknown";
  let category = "unclassified";
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; type?: unknown; message?: unknown } };
    const rawCode = parsed.error?.code ?? parsed.error?.type;
    if (
      typeof rawCode === "string"
      && /^[a-zA-Z0-9_.-]{1,80}$/u.test(rawCode)
      && !credentialShaped(rawCode)
    ) {
      code = rawCode;
    }
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
    if (/previous_response_id/iu.test(message)) category = "chain-reference";
    else if (/tool_choice/iu.test(message)) category = "tool-choice";
    else if (/\btools?\b/iu.test(message)) category = "tools";
    else if (/\bstore\b/iu.test(message)) category = "storage";
    else if (/encrypted_content/iu.test(message)) category = "encrypted-replay";
    else if (/reasoning/iu.test(message)) category = "reasoning";
    else if (/\binput\b/iu.test(message)) category = "input-schema";
  } catch {
    // Raw provider bodies are intentionally discarded.
  }
  return new Error(`Provider smoke ${phase} failed with HTTP ${response.status} (${code}; ${category})`);
}

async function postProviderResponse(
  runtime: CodexProxyRuntime,
  payload: JsonObject,
  phase: string,
): Promise<JsonObject> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${runtime.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const kind = error instanceof Error ? error.name : "unknown";
      throw new Error(`Provider smoke ${phase} failed before receiving HTTP response (${kind})`);
    }
    const text = await response.text();
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
        continue;
      }
      throw sanitizedProviderFailure(response, text, phase);
    }
    try {
      const parsed = JSON.parse(text) as JsonObject;
      responseId(parsed, phase);
      const lifecycleStatus = typeof parsed.status === "string" ? parsed.status.toLowerCase() : undefined;
      if (lifecycleStatus && lifecycleStatus !== "completed") {
        throw new Error(`Provider smoke ${phase} returned response status ${lifecycleStatus}`);
      }
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Provider smoke ${phase} returned malformed JSON`);
      throw error;
    }
  }
  throw new Error(`Provider smoke ${phase} exhausted its transient retry budget`);
}

function toolDefinition(): JsonObject {
  return {
    type: "function",
    name: "lookup_smoke_fixture",
    description: "Return one fixed synthetic smoke-test record.",
    strict: true,
    parameters: {
      type: "object",
      properties: { record: { type: "string" } },
      required: ["record"],
      additionalProperties: false,
    },
  };
}

function firstTurnPayload(params: {
  model: string;
  sessionId: string;
  evictText: string;
  keepText: string;
}): JsonObject {
  return {
    model: params.model,
    stream: false,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "medium", summary: "auto" },
    max_output_tokens: PROVIDER_SMOKE_MAX_OUTPUT_TOKENS,
    metadata: { tokenpilotSessionId: params.sessionId },
    instructions: "Reason about the two synthetic records, then reply with the single word READY.",
    input: [
      { role: "user", content: params.evictText },
      { role: "user", content: params.keepText },
    ],
  };
}

function continuationPayload(params: {
  model: string;
  previousResponseId: string;
  input: JsonObject[];
}): JsonObject {
  return {
    model: params.model,
    stream: false,
    store: true,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "low", summary: "auto" },
    max_output_tokens: PROVIDER_SMOKE_MAX_OUTPUT_TOKENS,
    tools: [toolDefinition()],
    tool_choice: "none",
    previous_response_id: params.previousResponseId,
    input: params.input,
  };
}

function toolRequestItem(): JsonObject {
  return { role: "user", content: "Use lookup_smoke_fixture for the retained synthetic record." };
}

function requiredToolCallPayload(params: {
  model: string;
  sessionId: string;
  historyInput: JsonObject[];
}): JsonObject {
  return {
    model: params.model,
    stream: false,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "low", summary: "auto" },
    max_output_tokens: PROVIDER_SMOKE_MAX_OUTPUT_TOKENS,
    metadata: { tokenpilotSessionId: params.sessionId },
    tools: [toolDefinition()],
    tool_choice: { type: "function", name: "lookup_smoke_fixture" },
    input: [...params.historyInput, toolRequestItem()],
  };
}

function storedRootPayload(params: {
  model: string;
  sessionId: string;
  historyInput: JsonObject[];
}): JsonObject {
  return {
    model: params.model,
    stream: false,
    // The provider smoke validates the stateless path, so every setup response
    // must return the opaque reasoning state required by later replay.
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "low", summary: "auto" },
    max_output_tokens: PROVIDER_SMOKE_MAX_OUTPUT_TOKENS,
    metadata: { tokenpilotSessionId: params.sessionId },
    tools: [toolDefinition()],
    tool_choice: "none",
    input: params.historyInput,
  };
}

function firstReasoning(response: JsonObject): {
  reasoning: JsonObject;
  encryptedPayload: string;
} {
  const output = jsonItems(response.output);
  const reasoning = output.find((item) => item.type === "reasoning");
  const encryptedPayload = typeof reasoning?.encrypted_content === "string"
    ? reasoning.encrypted_content
    : "";
  if (!reasoning) {
    const outputTypes = output.map((item) => typeof item.type === "string" ? item.type : "unknown").join(",") || "none";
    throw new Error(`Provider response did not include a reasoning item (output types: ${outputTypes})`);
  }
  if (!encryptedPayload) throw new Error("Provider response did not include encrypted reasoning content");
  return { reasoning, encryptedPayload };
}

async function postProviderEncryptedReasoningSample(params: {
  runtime: CodexProxyRuntime;
  payload: JsonObject;
  phase: string;
}): Promise<{ response: JsonObject; encryptedPayload: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await postProviderResponse(params.runtime, params.payload, params.phase);
    try {
      return {
        response,
        encryptedPayload: firstReasoning(response).encryptedPayload,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Provider response did not include replayable encrypted reasoning");
}

function requiredToolCall(response: JsonObject): { call: JsonObject; callId: string } {
  const call = jsonItems(response.output).find((item) => (
    item.type === "function_call" && item.name === "lookup_smoke_fixture"
  ));
  const callId = typeof call?.call_id === "string" ? call.call_id : "";
  if (!call || !callId) throw new Error("Provider response did not include the required function call");
  return { call, callId };
}

function syntheticConversationValues(marker: string): { evictText: string; keepText: string } {
  return {
    evictText: `EVICT_ME_${marker}\n${"discardable provider smoke context. ".repeat(180)}`,
    keepText: `KEEP_ME_${marker}`,
  };
}

async function setupStoredRoot(params: {
  runtime: CodexProxyRuntime;
  model: string;
  sessionId: string;
  evictText: string;
  keepText: string;
  phase: string;
}): Promise<{
  first: JsonObject;
  firstEncryptedPayload: string;
  toolResponse: JsonObject;
  toolOutputResponse: JsonObject;
  historyInput: JsonObject[];
  previousResponseId: string;
}> {
  const firstSample = await postProviderEncryptedReasoningSample({
    runtime: params.runtime,
    payload: firstTurnPayload({
      model: params.model,
      sessionId: params.sessionId,
      evictText: params.evictText,
      keepText: params.keepText,
    }),
    phase: `${params.phase} setup turn 1`,
  });
  const first = firstSample.response;
  const initialHistory = [
    { role: "user", content: params.evictText },
    { role: "user", content: params.keepText },
    ...jsonItems(first.output),
  ];
  const toolResponse = await postProviderResponse(params.runtime, requiredToolCallPayload({
    model: params.model,
    sessionId: params.sessionId,
    historyInput: initialHistory,
  }), `${params.phase} setup turn 2`);
  const toolCall = requiredToolCall(toolResponse);
  const toolOutputHistory = [
    ...initialHistory,
    toolRequestItem(),
    ...jsonItems(toolResponse.output),
    {
      type: "function_call_output",
      call_id: toolCall.callId,
      output: "retained synthetic tool result",
    },
  ];
  const toolOutputResponse = await postProviderResponse(params.runtime, storedRootPayload({
    model: params.model,
    sessionId: params.sessionId,
    historyInput: toolOutputHistory,
  }), `${params.phase} setup turn 3`);
  return {
    first,
    firstEncryptedPayload: firstSample.encryptedPayload,
    toolResponse,
    toolOutputResponse,
    historyInput: [...toolOutputHistory, ...jsonItems(toolOutputResponse.output)],
    previousResponseId: responseId(toolOutputResponse, `${params.phase} setup turn 3`),
  };
}

async function runControlConversation(params: {
  baseUrl: string;
  model: string;
  continuationTurns: number;
  marker: string;
}): Promise<ProviderConversationResult> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-provider-control-state-"));
  let runtime: CodexProxyRuntime | undefined;
  try {
    const config = buildProviderSmokeConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamBaseUrl: params.baseUrl,
      rewriteEnabled: false,
    });
    runtime = await startCodexResponsesProxy({ config, logger: silentLogger });
    const sessionId = `codex-provider-control-${randomUUID()}`;
    const values = syntheticConversationValues(params.marker);
    const setup = await setupStoredRoot({
      runtime,
      model: params.model,
      sessionId,
      ...values,
      phase: "control",
    });
    let historyInput = setup.historyInput;
    const continuationUsage: ProviderUsageObservation[] = [];
    for (let turn = 1; turn <= params.continuationTurns; turn += 1) {
      const currentInput = { role: "user", content: `Acknowledge continuation turn ${turn} with one word.` };
      const response = await postProviderResponse(runtime, storedRootPayload({
          model: params.model,
          sessionId,
          historyInput: [...historyInput, currentInput],
        }), `control continuation turn ${turn}`);
      historyInput = [...historyInput, currentInput, ...jsonItems(response.output)];
      continuationUsage.push(usageObservation(response));
    }
    return {
      setupUsage: [
        usageObservation(setup.first),
        usageObservation(setup.toolResponse),
        usageObservation(setup.toolOutputResponse),
      ],
      continuationUsage,
    };
  } finally {
    await runtime?.close();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function compatibilityMatrix(
  realProviderVerifiedItemTypes: string[],
  realProviderRejectedItemTypes: string[],
): ProviderCompatibilityMatrixEntry[] {
  const verified = new Set(realProviderVerifiedItemTypes);
  const rejected = new Set(realProviderRejectedItemTypes);
  const real = (itemType: string, policy: ProviderCompatibilityMatrixEntry["structuralPolicy"]): ProviderCompatibilityMatrixEntry => ({
    itemType,
    structuralPolicy: policy,
    providerDecision: verified.has(itemType)
      ? "real-pass"
      : rejected.has(itemType) ? "real-reject" : "not-observed",
    evidence: verified.has(itemType) || rejected.has(itemType) ? "real-provider" : "none",
    reason: verified.has(itemType)
      ? "provider_replay_succeeded"
      : rejected.has(itemType) ? "provider_replay_rejected" : "not_observed_in_provider_smoke",
  });
  return [
    real("previous_response_id", "transport"),
    real("message", "replay-candidate"),
    real("function_call", "closure-required"),
    real("function_call_output", "closure-required"),
    { itemType: "custom_tool_call", structuralPolicy: "closure-required", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "custom_tool_call_output", structuralPolicy: "closure-required", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "computer_call", structuralPolicy: "closure-required", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "computer_call_output", structuralPolicy: "closure-required", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "local_shell_call", structuralPolicy: "closure-required", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "local_shell_call_output", structuralPolicy: "closure-required", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "shell_call", structuralPolicy: "closure-required", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "shell_call_output", structuralPolicy: "closure-required", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "apply_patch_call", structuralPolicy: "closure-required", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "apply_patch_call_output", structuralPolicy: "closure-required", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    real("reasoning", "exact-payload"),
    { itemType: "compaction", structuralPolicy: "exact-payload", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "program", structuralPolicy: "exact-payload", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "program_output", structuralPolicy: "exact-payload", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "web_search_call", structuralPolicy: "replay-candidate", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "file_search_call", structuralPolicy: "replay-candidate", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "code_interpreter_call", structuralPolicy: "replay-candidate", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "image_generation_call", structuralPolicy: "replay-candidate", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "mcp_call", structuralPolicy: "replay-candidate", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "mcp_list_tools", structuralPolicy: "replay-candidate", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "mcp_approval_request", structuralPolicy: "replay-candidate", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "mcp_approval_response", structuralPolicy: "replay-candidate", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "tool_search_call", structuralPolicy: "replay-candidate", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "tool_search_output", structuralPolicy: "replay-candidate", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "additional_tools", structuralPolicy: "replay-candidate", providerDecision: "not-observed", evidence: "none", reason: "not_emitted_by_provider" },
    { itemType: "unknown", structuralPolicy: "deferred", providerDecision: "not-observed", evidence: "none", reason: "unknown_items_require_explicit_adapter_support" },
  ];
}

async function runRebaseConversation(params: {
  baseUrl: string;
  model: string;
  continuationTurns: number;
  marker: string;
}): Promise<ProviderRebaseResult> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-provider-rebase-state-"));
  const sessionId = `codex-provider-rebase-${randomUUID()}`;
  const values = syntheticConversationValues(params.marker);
  const currentInput = `CURRENT_INPUT_${params.marker}`;
  let runtime: CodexProxyRuntime | undefined;
  try {
    const config = buildProviderSmokeConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamBaseUrl: params.baseUrl,
      rewriteEnabled: true,
    });
    runtime = await startCodexResponsesProxy({ config, logger: silentLogger });
    const setup = await setupStoredRoot({
      runtime,
      model: params.model,
      sessionId,
      ...values,
      phase: "rebase",
    });
    let previousResponseId = setup.previousResponseId;
    const beforeRebase = await buildCodexEffectiveHistory({
      stateDir,
      sessionId,
      headResponseId: previousResponseId,
    });
    const evictedItem = beforeRebase.replayableItems.find((entry) => (
      JSON.stringify(entry.item).includes(values.evictText)
      || JSON.stringify(entry.item).includes("discardable provider smoke context")
    ));
    if (!evictedItem) {
      const diagnostic = await replayDiagnostic({ stateDir, sessionId, headResponseId: previousResponseId });
      throw new Error(
        `Provider smoke could not resolve the eviction target; ${diagnostic}; replayable=${beforeRebase.replayableItems.length}`,
      );
    }
    config.contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: evictedItem.stableItemId }],
    };

    const continuationUsage: ProviderUsageObservation[] = [];
    let rebaseResponse: JsonObject;
    try {
      rebaseResponse = await postProviderResponse(runtime, continuationPayload({
        model: params.model,
        previousResponseId,
        input: [{ role: "user", content: currentInput }],
      }), "rebase continuation turn 1");
    } catch (error) {
      const diagnostic = await replayDiagnostic({ stateDir, sessionId, headResponseId: previousResponseId });
      throw new Error(`${error instanceof Error ? error.message : String(error)}; ${diagnostic}`);
    }
    const newRootResponseId = responseId(rebaseResponse, "rebase continuation turn 1");
    previousResponseId = newRootResponseId;
    continuationUsage.push(usageObservation(rebaseResponse));
    config.contextRewrite.mutationPlan = { operations: [] };

    let restartPreserved = false;
    const expectedPreviousIds: string[] = [];
    for (let turn = 2; turn <= params.continuationTurns; turn += 1) {
      if (turn === 3) {
        const headBeforeRestart = previousResponseId;
        await runtime.close();
        runtime = undefined;
        const restartedConfig = buildProviderSmokeConfig({
          stateDir,
          proxyPort: await reserveFetchPort(),
          upstreamBaseUrl: params.baseUrl,
          rewriteEnabled: true,
        });
        runtime = await startCodexResponsesProxy({ config: restartedConfig, logger: silentLogger });
        restartPreserved = await resolveCodexSessionIdByResponseId(stateDir, headBeforeRestart) === sessionId;
      }
      expectedPreviousIds.push(previousResponseId);
      let response: JsonObject;
      try {
        response = await postProviderResponse(runtime, continuationPayload({
          model: params.model,
          previousResponseId,
          input: [{ role: "user", content: `Acknowledge continuation turn ${turn} with one word.` }],
        }), `rebase continuation turn ${turn}`);
      } catch (error) {
        const diagnostic = await replayDiagnostic({ stateDir, sessionId, headResponseId: previousResponseId });
        throw new Error(`${error instanceof Error ? error.message : String(error)}; ${diagnostic}`);
      }
      previousResponseId = responseId(response, `rebase continuation turn ${turn}`);
      continuationUsage.push(usageObservation(response));
    }

    const epoch = await readLatestCodexRebaseEpoch({ stateDir, sessionId });
    const journal = await loadCodexContextHistoryJournal(stateDir, sessionId);
    const committedRootResponse = journal.filter((entry) => (
      entry.kind === "response"
      && entry.responseId === newRootResponseId
      && entry.status === "completed"
      && entry.previousResponseId === null
    )).at(-1);
    const committedRootRequest = committedRootResponse?.requestId
      ? journal.find((entry) => (
        entry.kind === "request"
        && entry.requestId === committedRootResponse.requestId
        && entry.status === "completed"
        && Array.isArray(entry.committedInputItems)
      ))
      : undefined;
    const replayInput = committedRootRequest?.kind === "request"
      ? jsonItems(committedRootRequest.committedInputItems)
      : [];
    const replayText = JSON.stringify(replayInput);
    const replayReasoning = replayInput.filter((item) => item.type === "reasoning");
    const digestMatches = replayReasoning.some((item) => (
      typeof item.encrypted_content === "string"
      && sha256(item.encrypted_content) === sha256(setup.firstEncryptedPayload)
    ));
    const finalHistory = await buildCodexEffectiveHistory({
      stateDir,
      sessionId,
      headResponseId: previousResponseId,
    });
    const finalHistoryText = JSON.stringify(finalHistory.replayableItems);
    const linksValid = responseChainLinksValid({
      journal,
      rootResponseId: newRootResponseId,
      expectedPreviousIds,
      terminalResponseId: previousResponseId,
    });
    const terminalSessionMappingMatches =
      await resolveCodexSessionIdByResponseId(stateDir, previousResponseId) === sessionId;
    const capabilityJournal = await readCodexRebaseCapabilityJournal(stateDir);
    const realProviderVerifiedItemTypes = Array.from(new Set(
      capabilityJournal.capabilities
        .filter((entry) => entry.status === "verified_supported" && entry.evidence === "real_provider")
        .map((entry) => entry.itemType),
    )).sort();
    const realProviderRejectedItemTypes = Array.from(new Set(
      capabilityJournal.capabilities
        .filter((entry) => (
          entry.evidence === "real_provider"
          && (entry.status === "verified_unsupported" || entry.status === "payload_rejected")
        ))
        .map((entry) => entry.itemType),
    )).sort();

    return {
      setupUsage: [
        usageObservation(setup.first),
        usageObservation(setup.toolResponse),
        usageObservation(setup.toolOutputResponse),
      ],
      continuationUsage,
      capability: {
        responsesEndpointAccepted: true,
        reasoningItemPresent: true,
        encryptedReasoningPresent: true,
        encryptedPayloadChars: setup.firstEncryptedPayload.length,
        encryptedPayloadSha256: sha256(setup.firstEncryptedPayload),
        toolCallPresent: true,
        journalTrusted: !capabilityJournal.readError && capabilityJournal.malformedLineCount === 0,
        realProviderVerifiedItemTypes,
        realProviderRejectedItemTypes,
      },
      compatibilityMatrix: compatibilityMatrix(
        realProviderVerifiedItemTypes,
        realProviderRejectedItemTypes,
      ),
      rebase: {
        committed: epoch?.status === "committed",
        oldChainReferenceRemoved: Boolean(committedRootResponse)
          && newRootResponseId !== setup.previousResponseId,
        currentInputOccurrences: replayText.split(currentInput).length - 1,
        sentinel: {
          evictedAbsent: !replayText.includes(`EVICT_ME_${params.marker}`)
            && !finalHistoryText.includes(`EVICT_ME_${params.marker}`),
          retainedPresent: replayText.includes(`KEEP_ME_${params.marker}`)
            && finalHistoryText.includes(`KEEP_ME_${params.marker}`),
        },
        replayItemTypes: replayInput.map((item) => (
          typeof item.type === "string"
            ? item.type
            : typeof item.role === "string" ? `message:${item.role}` : "unknown"
        )),
        encryptedPayloadDigestMatches: digestMatches,
        toolClosure: toolClosureEvidence(replayInput),
        responseChain: {
          newRootPresent: newRootResponseId.length > 0,
          terminalPresent: previousResponseId.length > 0,
          terminalSessionMappingMatches,
          journalCommittedBeforeEpoch:
            epoch?.status === "committed"
            && epoch.newResponseId === newRootResponseId
            && typeof epoch.journalCommittedAt === "string"
            && Boolean(committedRootResponse)
            && Boolean(committedRootRequest)
            && Date.parse(epoch.journalCommittedAt) <= Date.parse(epoch.updatedAt),
          continuationTurns: params.continuationTurns,
          linksValid,
          restartPreserved,
          finalHistoryComplete: !finalHistory.incomplete,
        },
        estimatorAccounting: epoch?.accounting ? { ...epoch.accounting } : undefined,
      },
    };
  } finally {
    await runtime?.close();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

export function compareProviderUsage(
  baseline: ProviderUsageObservation[],
  rebase: ProviderUsageObservation[],
  setup: { baseline: ProviderUsageObservation[]; rebase: ProviderUsageObservation[] },
): ProviderUsageEvidence {
  if (baseline.length !== rebase.length || baseline.length === 0) {
    throw new Error("Provider smoke usage comparison requires equal non-empty turn sets");
  }
  let cumulativeSavedInputTokens = 0;
  const continuationTurns = baseline.map((baselineUsage, index) => {
    const rebaseUsage = rebase[index];
    if (!rebaseUsage) throw new Error("Provider smoke usage comparison lost a rebase turn");
    const savedInputTokens = baselineUsage.inputTokens - rebaseUsage.inputTokens;
    cumulativeSavedInputTokens += savedInputTokens;
    return {
      turn: index + 1,
      baselineInputTokens: baselineUsage.inputTokens,
      rebaseInputTokens: rebaseUsage.inputTokens,
      savedInputTokens,
      cumulativeSavedInputTokens,
      baselineCachedInputTokens: baselineUsage.cachedInputTokens,
      rebaseCachedInputTokens: rebaseUsage.cachedInputTokens,
    };
  });
  const observedBreakEvenTurn = continuationTurns
    .find((turn) => turn.cumulativeSavedInputTokens >= 0)?.turn;
  const rebaseTurnOverheadTokens = Math.max(0, rebase[0]!.inputTokens - baseline[0]!.inputTokens);
  const subsequentSavings = continuationTurns.slice(1).map((turn) => turn.savedInputTokens);
  const subsequentSavedInputTokensPerTurn = subsequentSavings.length > 0
    ? Math.round(subsequentSavings.reduce((sum, value) => sum + value, 0) / subsequentSavings.length)
    : continuationTurns[0]!.savedInputTokens;
  const projectedBreakEvenTurn = observedBreakEvenTurn
    ?? (subsequentSavedInputTokensPerTurn > 0
      ? 1 + Math.ceil(rebaseTurnOverheadTokens / subsequentSavedInputTokensPerTurn)
      : undefined);
  return {
    source: "provider-response-usage",
    comparableSetup: setup.baseline.length === setup.rebase.length && setup.baseline.length > 0,
    setup,
    continuationTurns,
    observedBreakEvenTurn,
    projectedBreakEvenTurn,
    rebaseTurnOverheadTokens,
    observedSavedInputTokens: cumulativeSavedInputTokens,
    subsequentSavedInputTokensPerTurn,
  };
}

function assertProviderEvidence(evidence: CodexRebaseProviderSmokeEvidence): void {
  const requiredVerified = ["message", "reasoning", "function_call", "function_call_output"];
  const missingVerified = requiredVerified.filter((itemType) => (
    !evidence.capability.realProviderVerifiedItemTypes.includes(itemType)
  ));
  const contradictoryCapabilities = evidence.capability.realProviderVerifiedItemTypes.filter((itemType) => (
    evidence.capability.realProviderRejectedItemTypes.includes(itemType)
  ));
  const checks: Array<[boolean, string]> = [
    [evidence.capability.responsesEndpointAccepted, "Responses endpoint was not accepted"],
    [evidence.capability.encryptedReasoningPresent, "Encrypted reasoning was not observed"],
    [evidence.capability.journalTrusted, "Capability journal was not trusted"],
    [missingVerified.length === 0, `Missing real-provider capability: ${missingVerified.join(",")}`],
    [contradictoryCapabilities.length === 0, `Contradictory capability evidence: ${contradictoryCapabilities.join(",")}`],
    [evidence.rebase.committed, "Rebase epoch was not committed"],
    [evidence.rebase.oldChainReferenceRemoved, "Old chain reference remained on the new root"],
    [evidence.rebase.currentInputOccurrences === 1, "Current input was not replayed exactly once"],
    [evidence.rebase.sentinel.evictedAbsent, "Eviction sentinel remained after rebase"],
    [evidence.rebase.sentinel.retainedPresent, "Retention sentinel was lost after rebase"],
    [evidence.rebase.encryptedPayloadDigestMatches, "Encrypted reasoning digest changed during replay"],
    [evidence.rebase.toolClosure.complete, "Tool call/output closure was not complete"],
    [evidence.rebase.responseChain.journalCommittedBeforeEpoch, "Epoch committed before the response journal"],
    [evidence.rebase.responseChain.continuationTurns >= 5, "Provider chain did not continue for five turns"],
    [evidence.rebase.responseChain.linksValid, "Provider response-chain links were invalid"],
    [evidence.rebase.responseChain.restartPreserved, "Proxy restart did not preserve the session mapping"],
    [evidence.rebase.responseChain.finalHistoryComplete, "Final effective history was incomplete"],
    [evidence.usage.comparableSetup, "Baseline and rebase setup were not comparable"],
    [evidence.usage.continuationTurns.every((turn) => (
      turn.baselineInputTokens > 0 && turn.rebaseInputTokens > 0
    )), "Provider usage did not include positive input-token observations"],
  ];
  const failure = checks.find(([passed]) => !passed);
  if (failure) throw new Error(`Provider smoke evidence gate failed: ${failure[1]}`);
}

async function writeEvidence(
  outputDir: string,
  evidence: CodexRebaseProviderSmokeEvidence,
): Promise<{ artifactPath: string; artifactSha256: string }> {
  await mkdir(outputDir, { recursive: true });
  const artifactPath = join(outputDir, "codex-context-rebase-provider-smoke.json");
  const tempPath = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(tempPath, text, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, artifactPath);
  return { artifactPath, artifactSha256: sha256(text) };
}

export async function runCodexRebaseProviderSmoke(
  options: RunCodexRebaseProviderSmokeOptions,
): Promise<CodexRebaseProviderSmokeRunResult> {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("Provider smoke requires OPENAI_API_KEY in the environment");
  }
  const baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error("Provider smoke requires a valid base URL");
  }
  if (
    parsedBaseUrl.protocol !== "https:"
    && parsedBaseUrl.hostname !== "127.0.0.1"
    && parsedBaseUrl.hostname !== "localhost"
  ) {
    throw new Error("Provider smoke requires HTTPS unless the provider is loopback-only");
  }
  const model = options.model?.trim() || "gpt-5.4-mini";
  const continuationTurns = options.continuationTurns ?? 5;
  if (!Number.isInteger(continuationTurns) || continuationTurns < 5 || continuationTurns > 20) {
    throw new Error("Provider smoke continuationTurns must be an integer from 5 to 20");
  }
  const startedAt = new Date().toISOString();
  const marker = randomUUID();
  // Proxy startup configures a process-global resolver, so the scenarios run serially.
  const baseline = await runControlConversation({ baseUrl, model, continuationTurns, marker });
  const rebase = await runRebaseConversation({ baseUrl, model, continuationTurns, marker });
  const usage = compareProviderUsage(
    baseline.continuationUsage,
    rebase.continuationUsage,
    { baseline: baseline.setupUsage, rebase: rebase.setupUsage },
  );
  const evidence: CodexRebaseProviderSmokeEvidence = {
    schema: CODEX_REBASE_PROVIDER_SMOKE_EVIDENCE_SCHEMA,
    mode: "provider",
    provider: "openai-compatible",
    endpoint: {
      host: sanitizedEvidenceLabel(parsedBaseUrl.hostname),
      sha256: sha256(baseUrl),
    },
    model: sanitizedEvidenceLabel(model),
    protocol: {
      wireMode: CODEX_REBASE_WIRE_MODE,
      apiVersion: CODEX_REBASE_API_VERSION,
      itemSchemaVersion: CODEX_REBASE_ITEM_SCHEMA_VERSION,
    },
    runtime: {
      node: process.version,
      codexCli: sanitizedEvidenceLabel(process.env.CODEX_CLI_VERSION),
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    capability: rebase.capability,
    compatibilityMatrix: rebase.compatibilityMatrix,
    rebase: rebase.rebase,
    controlledFailureCoverage: {
      source: "mock-automation",
      fallbackAtMostOnce: true,
      transientDoesNotPoisonCapability: true,
      payloadRejectionScopedByDigest: true,
      cooldownPreventsImmediateRetry: true,
    },
    usage,
    privacy: {
      credentialSource: "OPENAI_API_KEY",
      baseUrlSource: "OPENAI_BASE_URL-or-cli",
      rawPromptPersisted: false,
      rawEncryptedPayloadPersisted: false,
      rawResponseIdPersisted: false,
      rawHeadersPersisted: false,
      rawProviderErrorPersisted: false,
      ephemeralStateRemoved: true,
    },
  };
  assertProviderEvidence(evidence);
  const outputDir = options.outputDir
    ? resolve(options.outputDir)
    : await mkdtemp(join(tmpdir(), "lightmem2-codex-provider-smoke-evidence-"));
  return { ...await writeEvidence(outputDir, evidence), evidence };
}
