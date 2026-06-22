import test from "node:test";
import assert from "node:assert/strict";

import {
  createOpenClawPayloadCodec,
  createOpenClawSessionResolver,
  createOpenClawStreamCodec,
  createOpenClawStreamSnapshot,
  syncOpenClawPayloadFromEnvelope,
} from "./openclaw-host-adapter.js";

test("openclaw session resolver derives session metadata from payload", () => {
  const sessionResolver = createOpenClawSessionResolver({
    resolveSessionIdForPayload: () => "session-abc",
    extractInputText: () => "",
  });

  const session = sessionResolver.resolve(undefined, {
    metadata: {
      threadId: "thread-1",
      turnId: "turn-2",
    },
  });

  assert.equal(session.host.hostId, "openclaw");
  assert.equal(session.sessionId, "session-abc");
  assert.equal(session.threadId, "thread-1");
  assert.equal(session.turnId, "turn-2");
});

test("openclaw payload codec decodes and re-encodes request envelope", () => {
  const sessionResolver = createOpenClawSessionResolver({
    resolveSessionIdForPayload: () => "session-codec",
    extractInputText: (input) => Array.isArray(input) ? input.map((item: any) => String(item?.content ?? "")).join("\n") : "",
  });
  const codec = createOpenClawPayloadCodec(
    {
      resolveSessionIdForPayload: () => "session-codec",
      extractInputText: (input) => Array.isArray(input) ? input.map((item: any) => String(item?.content ?? "")).join("\n") : "",
    },
    sessionResolver,
  );

  const rawPayload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    stream: true,
    instructions: "developer instructions",
    input: [
      { role: "user", content: "hello" },
    ],
    tools: [{ type: "function", name: "search" }],
    prompt_cache_key: "runtime-pfx-demo",
    prompt_cache_retention: "24h",
    previous_response_id: "resp-prev",
  };

  const decoded = codec.decodeRequest(rawPayload);
  assert.equal(decoded.session.sessionId, "session-codec");
  assert.equal(decoded.model, "tokenpilot/gpt-5.4-mini");
  assert.equal(decoded.stream, true);
  assert.equal(decoded.instructions, "developer instructions");
  assert.equal(decoded.messages.length, 1);
  assert.equal(decoded.metadata?.promptCacheKey, "runtime-pfx-demo");
  assert.equal(decoded.metadata?.promptCacheRetention, "24h");
  assert.equal(decoded.metadata?.previousResponseId, "resp-prev");

  decoded.instructions = "rewritten";
  decoded.messages = [{ role: "user", content: "updated" }];
  decoded.metadata = {
    ...(decoded.metadata ?? {}),
    promptCacheKey: "runtime-pfx-next",
    promptCacheRetention: "12h",
    previousResponseId: "resp-next",
  };
  const encoded = codec.encodeRequest(decoded) as any;
  assert.equal(encoded.instructions, "rewritten");
  assert.deepEqual(encoded.input, [{ role: "user", content: "updated" }]);
  assert.equal(encoded.prompt_cache_key, "runtime-pfx-next");
  assert.equal(encoded.prompt_cache_retention, "12h");
  assert.equal(encoded.previous_response_id, "resp-next");
});

test("openclaw payload codec removes cleared request metadata on encode", () => {
  const sessionResolver = createOpenClawSessionResolver({
    resolveSessionIdForPayload: () => "session-codec-clear",
    extractInputText: () => "",
  });
  const codec = createOpenClawPayloadCodec(
    {
      resolveSessionIdForPayload: () => "session-codec-clear",
      extractInputText: () => "",
    },
    sessionResolver,
  );

  const decoded = codec.decodeRequest({
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    instructions: "developer instructions",
    input: [{ role: "user", content: "hello" }],
    prompt_cache_key: "runtime-pfx-demo",
    prompt_cache_retention: "24h",
    previous_response_id: "resp-prev",
  });

  decoded.instructions = undefined;
  decoded.metadata = {
    ...(decoded.metadata ?? {}),
    promptCacheKey: undefined,
    promptCacheRetention: undefined,
    previousResponseId: undefined,
  };

  const encoded = codec.encodeRequest(decoded) as any;
  assert.equal("instructions" in encoded, false);
  assert.equal("prompt_cache_key" in encoded, false);
  assert.equal("prompt_cache_retention" in encoded, false);
  assert.equal("previous_response_id" in encoded, false);
});

test("syncOpenClawPayloadFromEnvelope mutates raw payload in place", () => {
  const sessionResolver = createOpenClawSessionResolver({
    resolveSessionIdForPayload: () => "session-sync",
    extractInputText: () => "",
  });
  const codec = createOpenClawPayloadCodec(
    {
      resolveSessionIdForPayload: () => "session-sync",
      extractInputText: () => "",
    },
    sessionResolver,
  );
  const rawPayload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    instructions: "before instructions",
    input: [{ role: "user", content: "before" }],
    prompt_cache_key: "runtime-pfx-before",
    previous_response_id: "resp-before",
    prompt_cache_retention: "24h",
    tools: [{ type: "function", name: "search" }],
    staleField: "remove-me",
  };
  const envelope = codec.decodeRequest(rawPayload);
  envelope.instructions = undefined;
  envelope.messages = [{ role: "user", content: "after" }];
  envelope.tools = undefined;
  envelope.metadata = {
    ...(envelope.metadata ?? {}),
    promptCacheKey: undefined,
    promptCacheRetention: undefined,
    previousResponseId: undefined,
  };

  syncOpenClawPayloadFromEnvelope(rawPayload, envelope, codec);

  assert.equal("instructions" in rawPayload, false);
  assert.deepEqual(rawPayload.input, [{ role: "user", content: "after" }]);
  assert.equal("tools" in rawPayload, false);
  assert.equal("prompt_cache_key" in rawPayload, false);
  assert.equal("prompt_cache_retention" in rawPayload, false);
  assert.equal("previous_response_id" in rawPayload, false);
  assert.equal(rawPayload.staleField, "remove-me");
});

test("syncOpenClawPayloadFromEnvelope preserves object identity while replacing synchronized fields", () => {
  const sessionResolver = createOpenClawSessionResolver({
    resolveSessionIdForPayload: () => "session-sync-identity",
    extractInputText: () => "",
  });
  const codec = createOpenClawPayloadCodec(
    {
      resolveSessionIdForPayload: () => "session-sync-identity",
      extractInputText: () => "",
    },
    sessionResolver,
  );
  const rawPayload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    instructions: "before instructions",
    input: [{ role: "user", content: "before" }],
    tools: [{ type: "function", name: "search" }],
  };
  const originalRef = rawPayload;
  const envelope = codec.decodeRequest(rawPayload);
  envelope.messages = [
    { role: "developer", content: "rewritten" },
    { role: "user", content: "after" },
  ];
  envelope.instructions = "updated instructions";

  const synced = syncOpenClawPayloadFromEnvelope(rawPayload, envelope, codec);

  assert.equal(synced, originalRef);
  assert.equal(rawPayload.instructions, "updated instructions");
  assert.deepEqual(rawPayload.input, [
    { role: "developer", content: "rewritten" },
    { role: "user", content: "after" },
  ]);
});

test("openclaw payload codec decodes response envelope metadata and tool calls", () => {
  const sessionResolver = createOpenClawSessionResolver({
    resolveSessionIdForPayload: () => "session-response",
    extractInputText: () => "",
  });
  const codec = createOpenClawPayloadCodec(
    {
      resolveSessionIdForPayload: () => "session-response",
      extractInputText: () => "",
    },
    sessionResolver,
  );

  const response = codec.decodeResponse({
    id: "resp-1",
    previous_response_id: "resp-0",
    prompt_cache_key: "runtime-pfx-response",
    prompt_cache_retention: "24h",
    usage: { input_tokens: 10 },
    output: [
      {
        type: "function_call",
        id: "fc-1",
        call_id: "call-1",
        name: "search",
        arguments: "{\"q\":\"hello\"}",
        status: "completed",
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "done" }],
      },
    ],
  }, {} as any);

  assert.equal(response.metadata?.responseId, "resp-1");
  assert.equal(response.metadata?.previousResponseId, "resp-0");
  assert.equal(response.metadata?.promptCacheKey, "runtime-pfx-response");
  assert.equal(response.metadata?.promptCacheRetention, "24h");
  assert.equal(response.toolCalls?.length, 1);
  assert.equal(response.toolCalls?.[0]?.toolCallId, "call-1");
  assert.equal(response.toolCalls?.[0]?.toolName, "search");
});

test("openclaw stream codec extracts assistant text snapshot", () => {
  const codec = createOpenClawStreamCodec({
    extractProviderResponseText: (raw) => raw.includes("done") ? "done" : "",
    contentToText: (value) => String(value ?? ""),
  });

  const snapshot = createOpenClawStreamSnapshot("data: done\n\n", codec);
  assert.equal(snapshot.assistantText, "done");
  assert.equal(snapshot.rawStreamText, "data: done\n\n");
});
