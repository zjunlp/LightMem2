import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendCodexRebaseCapability,
  codexRebaseEndpointIdentity,
  executeCodexProviderContinuationWithReplay,
  readCodexRebaseCapabilityJournal,
  resolveCodexProviderContinuationCompatibility,
} from "../src/context-rewrite/index.js";
import {
  CODEX_REBASE_API_VERSION,
  CODEX_REBASE_ITEM_SCHEMA_VERSION,
  CODEX_REBASE_WIRE_MODE,
  CODEX_RESPONSE_CHAIN_CAPABILITY_ITEM_TYPE,
  type CodexRebaseCapabilityStoreParams,
  type JsonObject,
} from "../src/context-rewrite/types.js";

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-provider-continuation-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function capabilityStore(stateDir: string): CodexRebaseCapabilityStoreParams {
  return {
    stateDir,
    provider: "provider-fixture",
    model: "gpt-fixture",
    wireMode: CODEX_REBASE_WIRE_MODE,
    apiVersion: CODEX_REBASE_API_VERSION,
    endpointId: codexRebaseEndpointIdentity("https://provider.example/v1/responses"),
    itemSchemaVersion: CODEX_REBASE_ITEM_SCHEMA_VERSION,
    probeMode: "real_provider",
    now: "2026-08-08T00:00:00.000Z",
  };
}

const chainedPayload: JsonObject = {
  model: "gpt-fixture",
  previous_response_id: "resp-root",
  input: [{ type: "function_call_output", call_id: "call-1", output: "ok" }],
};
const encryptedReasoning = {
  type: "reasoning",
  encrypted_content: "opaque-encrypted-payload",
  summary: [],
};
const statelessReplayPayload: JsonObject = {
  model: "gpt-fixture",
  input: [
    { role: "user", content: "start" },
    encryptedReasoning,
    { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "ok" },
  ],
};

test("CDR-05 provider continuation retries explicit chain rejection as exact stateless replay", async () => {
  await withTempState(async (stateDir) => {
    const requests: JsonObject[] = [];
    const result = await executeCodexProviderContinuationWithReplay({
      chainedPayload,
      statelessReplayPayload,
      capabilityStore: capabilityStore(stateDir),
      async sendUpstream(payload) {
        requests.push(payload);
        return "previous_response_id" in payload
          ? {
            status: 400,
            headers: {},
            text: JSON.stringify({ error: { code: "invalid_request_error", message: "previous_response_id is not supported" } }),
          }
          : { status: 200, headers: {}, text: JSON.stringify({ id: "resp-stateless", status: "completed" }) };
      },
    });

    assert.equal(result.outcome, "stateless_replay");
    assert.equal(result.chainedResponse?.status, 400);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.previous_response_id, "resp-root");
    assert.equal("previous_response_id" in (requests[1] ?? {}), false);
    assert.equal(requests[1]?.store, false);
    assert.deepEqual(requests[1]?.include, ["reasoning.encrypted_content"]);
    assert.deepEqual((requests[1]?.input as JsonObject[])[1], encryptedReasoning);

    const journal = await readCodexRebaseCapabilityJournal(stateDir);
    const statuses = new Map(journal.capabilities.map((entry) => [entry.itemType, entry.status]));
    assert.equal(statuses.get(CODEX_RESPONSE_CHAIN_CAPABILITY_ITEM_TYPE), "verified_unsupported");
    assert.equal(statuses.get("reasoning"), "verified_supported");
    assert.equal(statuses.get("function_call"), "verified_supported");
    assert.equal(statuses.get("function_call_output"), "verified_supported");
  });
});

test("CDR-05 provider continuation uses cached chain incompatibility without repeating the rejected request", async () => {
  await withTempState(async (stateDir) => {
    const store = capabilityStore(stateDir);
    await appendCodexRebaseCapability({
      ...store,
      itemType: CODEX_RESPONSE_CHAIN_CAPABILITY_ITEM_TYPE,
      status: "verified_unsupported",
      evidence: "real_provider",
      reason: "response_chain_reference_unsupported",
      ttlMs: 60_000,
    });
    const requests: JsonObject[] = [];
    const result = await executeCodexProviderContinuationWithReplay({
      chainedPayload,
      statelessReplayPayload,
      capabilityStore: store,
      async sendUpstream(payload) {
        requests.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-stateless", status: "completed" }) };
      },
    });

    assert.equal(result.outcome, "stateless_replay");
    assert.equal(requests.length, 1);
    assert.equal("previous_response_id" in (requests[0] ?? {}), false);
  });
});

test("CDR-05 provider continuation retries once when requested encrypted reasoning is omitted", async () => {
  await withTempState(async (stateDir) => {
    const responses = [
      {
        status: 400,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ error: { code: "invalid_request_error", message: "previous_response_id is invalid" } }),
      },
      {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          id: "resp-missing-encrypted",
          status: "completed",
          output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [] }],
        }),
      },
      {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          id: "resp-with-encrypted",
          status: "completed",
          output: [{ type: "reasoning", encrypted_content: "next-opaque-state", summary: [] }],
        }),
      },
    ];
    let requestCount = 0;
    const result = await executeCodexProviderContinuationWithReplay({
      chainedPayload,
      statelessReplayPayload,
      capabilityStore: capabilityStore(stateDir),
      async sendUpstream() {
        const response = responses[requestCount];
        requestCount += 1;
        if (!response) throw new Error("unexpected provider request");
        return response;
      },
    });

    assert.equal(result.outcome, "stateless_replay");
    assert.equal(requestCount, 3);
    assert.match(result.response.text, /next-opaque-state/);
  });
});

test("CDR-05 provider continuation keeps native chaining after a successful provider response", async () => {
  await withTempState(async (stateDir) => {
    const requests: JsonObject[] = [];
    const result = await executeCodexProviderContinuationWithReplay({
      chainedPayload,
      statelessReplayPayload,
      capabilityStore: capabilityStore(stateDir),
      async sendUpstream(payload) {
        requests.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-chain", status: "completed" }) };
      },
    });

    assert.equal(result.outcome, "chained");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.previous_response_id, "resp-root");
    const journal = await readCodexRebaseCapabilityJournal(stateDir);
    assert.equal(
      journal.capabilities.find((entry) => entry.itemType === CODEX_RESPONSE_CHAIN_CAPABILITY_ITEM_TYPE)?.status,
      "verified_supported",
    );
    assert.equal(await resolveCodexProviderContinuationCompatibility({
      chainedPayload,
      capabilityStore: capabilityStore(stateDir),
    }), "verified_supported");
  });
});

test("CDR-05 provider continuation does not retry unrelated provider rejections", async () => {
  await withTempState(async (stateDir) => {
    let requestCount = 0;
    const result = await executeCodexProviderContinuationWithReplay({
      chainedPayload,
      statelessReplayPayload,
      capabilityStore: capabilityStore(stateDir),
      async sendUpstream() {
        requestCount += 1;
        return {
          status: 400,
          headers: {},
          text: JSON.stringify({ error: { code: "invalid_request_error", message: "invalid tool schema" } }),
        };
      },
    });

    assert.equal(result.outcome, "failed");
    assert.equal(requestCount, 1);
    const journal = await readCodexRebaseCapabilityJournal(stateDir);
    assert.equal(journal.capabilities.length, 0);
  });
});
