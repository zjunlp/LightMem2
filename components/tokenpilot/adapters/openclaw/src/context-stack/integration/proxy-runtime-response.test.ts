import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleNonStreamingProxyResponse, handleStreamingProxyResponse } from "./proxy-runtime-response.js";

function createMockResponse() {
  const headers = new Map<string, string>();
  let body = "";
  const events: Record<string, Array<() => void>> = {
    finish: [],
    close: [],
    unpipe: [],
    error: [],
  };

  const res = new Writable({
    write(chunk, _encoding, callback) {
      body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      callback();
    },
    final(callback) {
      for (const fn of events.finish) fn();
      callback();
    },
  }) as Writable & {
    statusCode?: number;
    setHeader: (name: string, value: string) => void;
    getHeader: (name: string) => string | undefined;
    hasHeader: (name: string) => boolean;
    end: (chunk?: string) => void;
    on: (event: "finish" | "close", handler: () => void) => any;
    body: () => string;
    closeNow: () => void;
  };

  res.setHeader = (name: string, value: string) => {
    headers.set(name.toLowerCase(), value);
  };
  res.getHeader = (name: string) => headers.get(name.toLowerCase());
  res.hasHeader = (name: string) => headers.has(name.toLowerCase());
  const originalOn = res.on.bind(res);
  const originalEnd = res.end.bind(res);
  res.on = ((event: string, handler: () => void) => {
    if (event in events) {
      events[event].push(handler);
    }
    return originalOn(event, handler as any);
  }) as any;
  res.end = ((chunk?: string) => {
    if (typeof chunk === "string") body += chunk;
    return originalEnd();
  }) as any;
  res.body = () => body;
  res.closeNow = () => {
    for (const fn of events.close) fn();
  };

  return res;
}

test("handleNonStreamingProxyResponse forwards reduced JSON response and records ux", async () => {
  const recordedUx: any[] = [];
  const traces: any[] = [];
  const reductionCalls: any[] = [];
  const responseLogs: any[] = [];
  const forwardingLogs: any[] = [];

  const res = createMockResponse();

  await handleNonStreamingProxyResponse({
    cfg: {
      stateDir: "/tmp/tokenpilot-proxy-runtime-response-test",
      modules: { reduction: true },
      reduction: { engine: "layered", passes: {} },
    },
    res,
    helpers: {
      requestUpstreamResponses: async () => ({
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        text: JSON.stringify({
          id: "resp_1",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "original response" }],
            },
          ],
          output_text: "original response",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
        transport: "fetch",
      }),
      applyLayeredReductionAfterCall: async (_payload: any, parsed: any) => {
        reductionCalls.push(parsed);
        parsed.output_text = "reduced response";
        parsed.output[0].content[0].text = "reduced response";
        return {
          changed: true,
          savedChars: 8,
          passCount: 1,
          report: [{ id: "format_slimming", changed: true }],
        };
      },
      isSseContentType: (contentType: string) => contentType.includes("text/event-stream"),
      extractInputText: (input: any) => Array.isArray(input) ? input.map((item) => String(item?.content ?? "")).join("\n") : "",
      extractProviderResponseText: () => "",
      contentToText: (value: unknown) => String(value ?? ""),
      appendTaskStateTrace: async (_stateDir: string, payload: any) => {
        traces.push(payload);
      },
      countTokensWithFallback: async (_model: string, text: string) => ({
        count: text.length,
        mode: "chars" as const,
      }),
      recordUxEffect: async (_stateDir: string, payload: any) => {
        recordedUx.push(payload);
      },
      appendJsonl: async () => undefined,
      appendForwardedInputDump: async () => undefined,
      appendReductionPassTrace: async () => undefined,
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    upstream: {
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      apiFamily: "openai-responses",
    },
    activePayload: {
      prompt_cache_key: "runtime-pfx-test",
      prompt_cache_retention: "24h",
      input: [{ role: "user", content: "hello" }],
    },
    resolvedSessionId: "session-non-stream",
    model: "tokenpilot/gpt-5.4-mini",
    upstreamModel: "gpt-5.4-mini",
    proxyPureForward: false,
    originalInputText: "hello original",
    afterReductionInputText: "hello reduced",
    beforeReductionCanonicalInput: "hello original canonical",
    afterReductionCanonicalInput: "hello reduced canonical",
    reductionApplied: { changedItems: 1, changedBlocks: 1, savedChars: 10, report: [] },
    reductionPassOptions: {},
    reductionMaxToolChars: 1200,
    reductionTriggerMinChars: 2200,
  } as any);

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("content-type"), "application/json; charset=utf-8");
  assert.match(res.body(), /reduced response/);
  assert.equal(reductionCalls.length, 1);
  assert.equal(recordedUx.length, 1);
  assert.equal(recordedUx[0].details?.responseSavedCount, 8);
  assert.equal(traces.some((item) => item.stage === "proxy_after_call_rewrite"), true);
  assert.equal(responseLogs.length, 0);
  assert.equal(forwardingLogs.length, 0);
});

test("handleNonStreamingProxyResponse skips reduction effects when module is disabled", async () => {
  const traces: any[] = [];
  let reductionCalls = 0;
  let reductionTraceCalls = 0;
  let uxCalls = 0;
  const res = createMockResponse();

  await handleNonStreamingProxyResponse({
    cfg: {
      stateDir: "/tmp/tokenpilot-proxy-runtime-response-disabled-test",
      modules: { reduction: false },
      reduction: { engine: "layered", passes: {} },
      debugTapPath: "/tmp/tokenpilot-proxy-runtime-response-disabled-debug.jsonl",
      debugTapProviderTraffic: false,
    },
    res,
    helpers: {
      requestUpstreamResponses: async () => ({
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        text: JSON.stringify({ id: "resp-disabled", output: [], output_text: "unchanged" }),
        transport: "fetch",
      }),
      applyLayeredReductionAfterCall: async () => {
        reductionCalls += 1;
        throw new Error("disabled reduction must not run after-call passes");
      },
      isSseContentType: () => false,
      extractInputText: () => "hello",
      extractProviderResponseText: () => "",
      contentToText: (value: unknown) => String(value ?? ""),
      appendTaskStateTrace: async (_stateDir: string, payload: any) => traces.push(payload),
      countTokensWithFallback: async () => ({ count: 1, mode: "chars" as const }),
      recordUxEffect: async () => {
        uxCalls += 1;
      },
      appendJsonl: async () => undefined,
      appendForwardedInputDump: async () => undefined,
      appendReductionPassTrace: async () => {
        reductionTraceCalls += 1;
      },
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    upstream: {
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      apiFamily: "openai-responses",
    },
    activePayload: { input: [{ role: "user", content: "hello" }] },
    resolvedSessionId: "session-disabled",
    model: "tokenpilot/gpt-5.4-mini",
    upstreamModel: "gpt-5.4-mini",
    proxyPureForward: false,
    originalInputText: "hello",
    afterReductionInputText: "hello",
    beforeReductionCanonicalInput: "hello",
    afterReductionCanonicalInput: "hello",
    reductionApplied: { changedItems: 0, changedBlocks: 0, savedChars: 0 },
    reductionPassOptions: {},
    reductionMaxToolChars: 1200,
    reductionTriggerMinChars: 2200,
  } as any);

  assert.equal(reductionCalls, 0);
  assert.equal(reductionTraceCalls, 0);
  assert.equal(uxCalls, 0);
  assert.equal(traces.some((item) => item.stage === "proxy_after_call_rewrite"), false);
  assert.match(res.body(), /unchanged/);
});

test("handleStreamingProxyResponse forwards stream and records stream ux after finish", async () => {
  const recordedUx: any[] = [];
  const traces: any[] = [];
  const stream = Readable.from([
    Buffer.from('data: {"response":{"prompt_cache_key":"pk-stream-2"}}\n\n'),
    Buffer.from('data: {"usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":80}}}\n\n'),
    Buffer.from('data: {"type":"response.output_text.delta","delta":"Hello "}\n\n'),
    Buffer.from('data: {"type":"response.output_text.done","text":"Hello world"}\n\n'),
    Buffer.from("data: [DONE]\n\n"),
  ]);

  const res = createMockResponse();

  await handleStreamingProxyResponse({
    cfg: {
      stateDir: "/tmp/tokenpilot-proxy-runtime-stream-test",
      modules: { reduction: true },
    },
    res,
    helpers: {
      requestUpstreamResponsesStream: async () => ({
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
        stream,
        transport: "fetch",
      }),
      appendTaskStateTrace: async (_stateDir: string, payload: any) => {
        traces.push(payload);
      },
      extractProviderResponseText: (raw: string) => raw.includes("Hello world") ? "Hello world" : "",
      contentToText: (value: unknown) => String(value ?? ""),
      countTokensWithFallback: async (_model: string, text: string) => ({
        count: text.length,
        mode: "chars" as const,
      }),
      recordUxEffect: async (_stateDir: string, payload: any) => {
        recordedUx.push(payload);
      },
    },
    logger: {
      warn: () => undefined,
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    upstream: {
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      apiFamily: "openai-responses",
    },
    activePayload: {
      input: [{ role: "user", content: "hello" }],
    },
    resolvedSessionId: "session-stream",
    model: "tokenpilot/gpt-5.4-mini",
    upstreamModel: "gpt-5.4-mini",
    proxyPureForward: false,
    originalInputText: "hello original",
    afterReductionInputText: "hello reduced",
    beforeReductionCanonicalInput: "hello original canonical",
    afterReductionCanonicalInput: "hello reduced canonical",
    reductionApplied: { savedChars: 10 },
    cacheAuditSnapshot: {
      sessionId: "session-stream",
      model: "tokenpilot/gpt-5.4-mini",
      stream: true,
      stablePrefixFingerprint: "fp-stream",
      stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
      entropyFindings: [],
      driftReasons: [],
      requestPromptCacheKey: "pk-stream-1",
    },
  } as any);

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("content-type"), "text/event-stream; charset=utf-8");
  assert.match(res.body(), /response\.output_text\.done/);
  assert.equal(recordedUx.length, 1);
  assert.equal(recordedUx[0].savedCount, "hello original canonical".length - "hello reduced canonical".length);
  assert.equal(traces.some((item) => item.stage === "proxy_stream_forward"), true);
});

test("handleStreamingProxyResponse records cache-audit response prompt_cache_key and usage from SSE stream", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-openclaw-stream-cache-audit-"));
  const stream = Readable.from([
    Buffer.from('data: {"response":{"prompt_cache_key":"pk-stream-2"}}\n\n'),
    Buffer.from('data: {"usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":80}}}\n\n'),
    Buffer.from('data: {"type":"response.output_text.done","text":"Hello world"}\n\n'),
    Buffer.from("data: [DONE]\n\n"),
  ]);
  const res = createMockResponse();

  try {
    await handleStreamingProxyResponse({
      cfg: {
        stateDir,
      },
      res,
      helpers: {
        requestUpstreamResponsesStream: async () => ({
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
          stream,
          transport: "fetch",
        }),
        appendTaskStateTrace: async () => undefined,
        extractProviderResponseText: () => "Hello world",
        contentToText: (value: unknown) => String(value ?? ""),
        countTokensWithFallback: async (_model: string, text: string) => ({
          count: text.length,
          mode: "chars" as const,
        }),
        recordUxEffect: async () => undefined,
      },
      logger: {
        warn: () => undefined,
        info: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      upstream: {
        baseUrl: "https://example.com/v1",
        apiKey: "test-key",
        apiFamily: "openai-responses",
      },
      activePayload: {
        input: [{ role: "user", content: "hello" }],
      },
      resolvedSessionId: "session-stream",
      model: "tokenpilot/gpt-5.4-mini",
      upstreamModel: "gpt-5.4-mini",
      proxyPureForward: false,
      originalInputText: "hello original",
      afterReductionInputText: "hello reduced",
      beforeReductionCanonicalInput: "hello original canonical",
      afterReductionCanonicalInput: "hello reduced canonical",
      reductionApplied: { savedChars: 10 },
      cacheAuditSnapshot: {
        sessionId: "session-stream",
        model: "tokenpilot/gpt-5.4-mini",
        stream: true,
        stablePrefixFingerprint: "fp-stream",
        stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
        entropyFindings: [],
        driftReasons: [],
        requestPromptCacheKey: "pk-stream-1",
      },
    } as any);

    const raw = await readFile(join(stateDir, "cache-audit.jsonl"), "utf8");
    const records = raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0]?.requestPromptCacheKey, "pk-stream-1");
    assert.equal(records[0]?.responsePromptCacheKey, "pk-stream-2");
    assert.equal(records[0]?.cachedInputTokens, 80);
    assert.equal(records[0]?.baselineKind, "none");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
