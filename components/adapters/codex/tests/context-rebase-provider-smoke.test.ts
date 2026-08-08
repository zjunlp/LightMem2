import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_REBASE_PROVIDER_SMOKE_EVIDENCE_SCHEMA,
  compareProviderUsage,
  runCodexRebaseProviderSmoke,
  sanitizedEvidenceLabel,
} from "../src/context-rebase-provider-smoke.js";
import type { JsonObject } from "../src/context-history/index.js";

async function requestBody(req: IncomingMessage): Promise<JsonObject> {
  return new Promise<JsonObject>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function startProviderFixture(options: { rejectWithSecret?: boolean } = {}): Promise<{
  baseUrl: string;
  authorizationPresent(): boolean;
  close(): Promise<void>;
}> {
  let ordinal = 0;
  let sawAuthorization = true;
  const contextCharsByResponse = new Map<string, number>();
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    sawAuthorization = sawAuthorization && /^Bearer\s+\S+$/u.test(String(req.headers.authorization ?? ""));
    if (options.rejectWithSecret) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "invalid_request_error", message: "bad input secret-provider-body" } }));
      return;
    }
    const payload = await requestBody(req);
    ordinal += 1;
    const id = `resp-provider-fixture-${ordinal}`;
    const previousId = typeof payload.previous_response_id === "string"
      ? payload.previous_response_id
      : undefined;
    const previousContextChars = previousId ? contextCharsByResponse.get(previousId) ?? 0 : 0;
    const currentChars = JSON.stringify(payload.input ?? []).length;
    const forcedToolCall = payload.tool_choice
      && typeof payload.tool_choice === "object"
      && !Array.isArray(payload.tool_choice);
    const encryptedContent = `opaque-provider-fixture-${ordinal}`;
    const output = forcedToolCall
      ? [
        { id: `reasoning-${ordinal}`, type: "reasoning", encrypted_content: encryptedContent, summary: [] },
        {
          id: `call-item-${ordinal}`,
          type: "function_call",
          call_id: `call-provider-fixture-${ordinal}`,
          name: "lookup_smoke_fixture",
          arguments: "{\"record\":\"retained\"}",
        },
      ]
      : [
        { id: `reasoning-${ordinal}`, type: "reasoning", encrypted_content: encryptedContent, summary: [] },
        {
          id: `message-${ordinal}`,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "OK" }],
        },
      ];
    const outputChars = JSON.stringify(output).length;
    const nextContextChars = previousContextChars + currentChars + outputChars;
    contextCharsByResponse.set(id, nextContextChars);
    const inputTokens = Math.ceil((previousContextChars + currentChars) / 4);
    const outputTokens = Math.ceil(outputChars / 4);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id,
      object: "response",
      status: "completed",
      previous_response_id: previousId,
      output,
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    authorizationPresent: () => sawAuthorization,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

test("provider usage comparison reports observed and projected break-even", () => {
  const observation = (inputTokens: number) => ({
    inputTokens,
    cachedInputTokens: 0,
    outputTokens: 1,
    totalTokens: inputTokens + 1,
  });
  const evidence = compareProviderUsage(
    [observation(120), observation(140), observation(160)],
    [observation(150), observation(100), observation(100)],
    { baseline: [observation(20)], rebase: [observation(20)] },
  );
  assert.equal(evidence.comparableSetup, true);
  assert.equal(evidence.observedBreakEvenTurn, 2);
  assert.equal(evidence.projectedBreakEvenTurn, 2);
  assert.equal(evidence.rebaseTurnOverheadTokens, 30);
  assert.equal(evidence.observedSavedInputTokens, 70);
  assert.equal(evidence.subsequentSavedInputTokensPerTurn, 50);
});

test("provider smoke emits sanitized real-chain, capability v2, matrix, and usage evidence", async () => {
  const provider = await startProviderFixture();
  const outputDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-provider-smoke-test-"));
  const previousKey = process.env.OPENAI_API_KEY;
  const previousCli = process.env.CODEX_CLI_VERSION;
  process.env.OPENAI_API_KEY = "provider-smoke-test-key-not-secret";
  process.env.CODEX_CLI_VERSION = "sk-credential-shaped-cli-label";
  try {
    const result = await runCodexRebaseProviderSmoke({
      baseUrl: provider.baseUrl,
      model: "provider-fixture-model",
      continuationTurns: 5,
      outputDir,
    });
    const evidence = result.evidence;
    const artifactText = await readFile(result.artifactPath, "utf8");

    assert.equal(evidence.schema, CODEX_REBASE_PROVIDER_SMOKE_EVIDENCE_SCHEMA);
    assert.equal(evidence.mode, "provider");
    assert.equal(evidence.runtime.codexCli, "not-observed");
    assert.equal(evidence.capability.encryptedReasoningPresent, true);
    assert.equal(evidence.capability.journalTrusted, true);
    assert.deepEqual(evidence.capability.realProviderVerifiedItemTypes, [
      "function_call",
      "function_call_output",
      "message",
      "previous_response_id",
      "reasoning",
    ]);
    assert.deepEqual(evidence.capability.realProviderRejectedItemTypes, []);
    assert.equal(evidence.rebase.committed, true);
    assert.equal(evidence.rebase.oldChainReferenceRemoved, true);
    assert.equal(evidence.rebase.currentInputOccurrences, 1);
    assert.deepEqual(evidence.rebase.sentinel, { evictedAbsent: true, retainedPresent: true });
    assert.equal(evidence.rebase.encryptedPayloadDigestMatches, true);
    assert.deepEqual(evidence.rebase.toolClosure, { callCount: 1, outputCount: 1, complete: true });
    assert.equal(evidence.rebase.responseChain.continuationTurns, 5);
    assert.equal(evidence.rebase.responseChain.linksValid, true);
    assert.equal(evidence.rebase.responseChain.restartPreserved, true);
    assert.equal(evidence.rebase.responseChain.finalHistoryComplete, true);
    assert.equal(evidence.usage.continuationTurns.length, 5);
    assert.ok(evidence.usage.observedSavedInputTokens > 0);
    assert.equal(evidence.compatibilityMatrix.find((entry) => entry.itemType === "reasoning")?.providerDecision, "real-pass");
    assert.equal(evidence.compatibilityMatrix.find((entry) => entry.itemType === "previous_response_id")?.providerDecision, "real-pass");
    assert.equal(evidence.compatibilityMatrix.find((entry) => entry.itemType === "compaction")?.providerDecision, "not-observed");
    assert.equal(provider.authorizationPresent(), true);
    assert.match(result.artifactSha256, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.parse(artifactText).schema, CODEX_REBASE_PROVIDER_SMOKE_EVIDENCE_SCHEMA);
    assert.doesNotMatch(artifactText, /EVICT_ME_|KEEP_ME_|CURRENT_INPUT_|opaque-provider-fixture-/u);
    assert.doesNotMatch(artifactText, /provider-smoke-test-key-not-secret|sk-credential-shaped-cli-label/u);
    assert.doesNotMatch(artifactText, /authorization|bearer/iu);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousCli === undefined) delete process.env.CODEX_CLI_VERSION;
    else process.env.CODEX_CLI_VERSION = previousCli;
    await provider.close();
    await rm(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("provider smoke rejects credential-shaped evidence labels and raw provider errors", async () => {
  const credentialShapedFixtures = [
    ["sk", "sensitive-model-label"].join("-"),
    ["AKIA", "1234567890ABCDEF"].join(""),
    ["ghp", "123456789012345678901234567890123456"].join("_"),
    ["github", "pat", "123456789012345678901234567890123456"].join("_"),
    ["xoxb", "1234567890", "1234567890", "abcdefghijklmnop"].join("-"),
    ["tvly", "dev", "22fIaq", "lFQoPTRTrJhbIJxRIEiQVLwL99"].join("-"),
  ];
  for (const fixture of credentialShapedFixtures) {
    assert.equal(sanitizedEvidenceLabel(fixture), "not-observed");
  }
  assert.equal(sanitizedEvidenceLabel("gpt-safe-model"), "gpt-safe-model");
  const provider = await startProviderFixture({ rejectWithSecret: true });
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-key";
  try {
    await assert.rejects(
      runCodexRebaseProviderSmoke({ baseUrl: provider.baseUrl, continuationTurns: 5 }),
      (error: unknown) => {
        assert.match(String(error), /control setup turn 1 failed with HTTP 400 \(invalid_request_error; input-schema\)/u);
        assert.doesNotMatch(String(error), /secret-provider-body/u);
        return true;
      },
    );
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await provider.close();
  }
});
