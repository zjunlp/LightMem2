import { collectCodexResponseItemsFromStream } from "../context-history/sse-item-collector.js";
import { cloneJson } from "./shared.js";
import {
  appendCodexRebaseCapability,
  classifyCodexRebaseCapabilityRejection,
  codexRebasePayloadDigest,
  codexRebasePayloadItems,
  resolveCodexProviderReplayCompatibility,
} from "./rebase-capability.js";
import {
  CODEX_RESPONSE_CHAIN_CAPABILITY_ITEM_TYPE,
  type CodexProviderContinuationResult,
  type CodexRebaseCapabilityStoreParams,
  type CodexRebaseCapabilityStatus,
  type CodexUpstreamResponse,
  type CodexUpstreamSender,
  type JsonObject,
} from "./types.js";

export type CodexProviderContinuationCompatibility =
  | "verified_supported"
  | "verified_unsupported"
  | "unknown";

function successful(response: CodexUpstreamResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

function previousResponseId(payload: JsonObject): string | undefined {
  return typeof payload.previous_response_id === "string" && payload.previous_response_id.trim()
    ? payload.previous_response_id.trim()
    : undefined;
}

function replayRequiresEncryptedReasoning(payload: JsonObject): boolean {
  if (payload.reasoning && typeof payload.reasoning === "object") return true;
  return Array.isArray(payload.input) && payload.input.some((item) => (
    item && typeof item === "object" && !Array.isArray(item)
    && ["reasoning", "compaction", "program", "program_output"].includes(
      String((item as JsonObject).type ?? "").toLowerCase(),
    )
  ));
}

function statelessContinuationPayload(payload: JsonObject): JsonObject {
  const next = cloneJson(payload);
  delete next.previous_response_id;
  // A provider that cannot dereference response ids cannot supply future
  // reasoning state from storage. Keep each continuation self-contained.
  next.store = false;
  if (replayRequiresEncryptedReasoning(next)) {
    const include = Array.isArray(next.include)
      ? next.include.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (!include.includes("reasoning.encrypted_content")) {
      include.push("reasoning.encrypted_content");
    }
    next.include = include;
  }
  return next;
}

export async function resolveCodexProviderContinuationCompatibility(params: {
  chainedPayload: JsonObject;
  capabilityStore: CodexRebaseCapabilityStoreParams;
}): Promise<CodexProviderContinuationCompatibility> {
  const chainId = previousResponseId(params.chainedPayload);
  if (!chainId) return "unknown";
  try {
    const compatibility = await resolveCodexProviderReplayCompatibility({
      ...params.capabilityStore,
      items: [{
        itemType: CODEX_RESPONSE_CHAIN_CAPABILITY_ITEM_TYPE,
        payloadDigest: codexRebasePayloadDigest(chainId),
      }],
      acceptedEvidence: params.capabilityStore.probeMode === "mock_fixture"
        ? ["real_provider", "mock_fixture"]
        : ["real_provider"],
    });
    if (!compatibility.journalTrusted) return "unknown";
    const status = compatibility.decisions[0]?.status;
    return status === "verified_supported" || status === "verified_unsupported"
      ? status
      : "unknown";
  } catch {
    return "unknown";
  }
}

function responseOutputItems(response: CodexUpstreamResponse): JsonObject[] {
  const contentType = Object.entries(response.headers)
    .find(([name]) => name.toLowerCase() === "content-type")?.[1]
    ?.toLowerCase();
  if (contentType?.includes("text/event-stream") || /^event:\s*response\./mu.test(response.text)) {
    return collectCodexResponseItemsFromStream(response.text).outputItems;
  }
  try {
    const parsed = JSON.parse(response.text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const output = (parsed as JsonObject).output;
    return Array.isArray(output)
      ? output.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      : [];
  } catch {
    return [];
  }
}

function responseMissingRequestedEncryptedReasoning(
  request: JsonObject,
  response: CodexUpstreamResponse,
): boolean {
  const include = Array.isArray(request.include) ? request.include : [];
  if (!include.includes("reasoning.encrypted_content")) return false;
  return responseOutputItems(response).some((item) => {
    const type = String(item.type ?? "").toLowerCase();
    return (type === "reasoning" || type === "compaction")
      && (typeof item.encrypted_content !== "string" || !item.encrypted_content.trim());
  });
}

export async function executeCodexProviderContinuationWithReplay(params: {
  chainedPayload: JsonObject;
  statelessReplayPayload: JsonObject;
  sendUpstream: CodexUpstreamSender;
  capabilityStore: CodexRebaseCapabilityStoreParams;
}): Promise<CodexProviderContinuationResult> {
  const chainId = previousResponseId(params.chainedPayload);
  if (!chainId || "previous_response_id" in params.statelessReplayPayload) {
    throw new Error("Codex provider continuation fallback requires chained and stateless payloads");
  }

  const store = params.capabilityStore;
  const evidence = store.probeMode === "mock_fixture" ? "mock_fixture" : "real_provider";
  const statelessPayload = statelessContinuationPayload(params.statelessReplayPayload);
  const replayItems = codexRebasePayloadItems(statelessPayload);
  const chainItem = {
    itemType: CODEX_RESPONSE_CHAIN_CAPABILITY_ITEM_TYPE,
    payloadDigest: codexRebasePayloadDigest(chainId),
  };

  async function safeRecord(paramsForRecord: {
    itemType: string;
    status: CodexRebaseCapabilityStatus;
    reason: string;
    responseStatus?: number;
    errorCode?: string;
    payloadDigest?: string;
  }): Promise<void> {
    try {
      await appendCodexRebaseCapability({
        stateDir: store.stateDir,
        provider: store.provider,
        model: store.model,
        wireMode: store.wireMode,
        apiVersion: store.apiVersion,
        endpointId: store.endpointId,
        itemType: paramsForRecord.itemType,
        itemSchemaVersion: store.itemSchemaVersion,
        status: paramsForRecord.status,
        evidence,
        payloadDigest: paramsForRecord.status === "payload_rejected"
          ? paramsForRecord.payloadDigest
          : undefined,
        reason: paramsForRecord.reason,
        responseStatus: paramsForRecord.responseStatus,
        errorCode: paramsForRecord.errorCode,
        observedAt: store.now,
        ttlMs: store.ttlMs,
      });
    } catch {
      // Provider capability evidence is advisory. Request delivery must continue.
    }
  }

  async function recordReplayResult(response: CodexUpstreamResponse): Promise<void> {
    if (successful(response)) {
      for (const item of replayItems) {
        await safeRecord({
          itemType: item.itemType,
          status: "verified_supported",
          reason: "stateless_continuation_succeeded",
          responseStatus: response.status,
        });
      }
      return;
    }
    const classification = classifyCodexRebaseCapabilityRejection({ response, items: replayItems });
    if (classification.kind === "item_unsupported") {
      for (const itemType of classification.itemTypes) {
        await safeRecord({
          itemType,
          status: "verified_unsupported",
          reason: "item_schema_unsupported",
          responseStatus: response.status,
          errorCode: classification.errorCode,
        });
      }
    } else if (classification.kind === "payload_rejected") {
      const rejected = replayItems.filter((item) => classification.itemTypes.includes(item.itemType));
      for (const item of rejected) {
        await safeRecord({
          itemType: item.itemType,
          status: "payload_rejected",
          payloadDigest: item.payloadDigest,
          reason: "encrypted_payload_rejected",
          responseStatus: response.status,
          errorCode: classification.errorCode,
        });
      }
    }
  }

  async function sendStateless(
    chainedResponse?: CodexUpstreamResponse,
  ): Promise<CodexProviderContinuationResult> {
    let response = await params.sendUpstream(cloneJson(statelessPayload));
    if (successful(response) && responseMissingRequestedEncryptedReasoning(statelessPayload, response)) {
      response = await params.sendUpstream(cloneJson(statelessPayload));
    }
    await recordReplayResult(response);
    return {
      response,
      outcome: successful(response) ? "stateless_replay" : "failed",
      chainedResponse,
    };
  }

  if (await resolveCodexProviderContinuationCompatibility({
    chainedPayload: params.chainedPayload,
    capabilityStore: store,
  }) === "verified_unsupported") {
    return sendStateless();
  }

  const chainedResponse = await params.sendUpstream(cloneJson(params.chainedPayload));
  if (successful(chainedResponse)) {
    await safeRecord({
      itemType: chainItem.itemType,
      status: "verified_supported",
      reason: "response_chain_continuation_succeeded",
      responseStatus: chainedResponse.status,
    });
    return { response: chainedResponse, outcome: "chained" };
  }

  const classification = classifyCodexRebaseCapabilityRejection({
    response: chainedResponse,
    items: [chainItem],
  });
  if (classification.kind !== "chain_reference_unsupported") {
    return { response: chainedResponse, outcome: "failed" };
  }

  await safeRecord({
    itemType: chainItem.itemType,
    status: "verified_unsupported",
    reason: "response_chain_reference_unsupported",
    responseStatus: chainedResponse.status,
    errorCode: classification.errorCode,
  });
  return sendStateless(chainedResponse);
}
