import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import { prepareCodexStablePrefix } from "../src/stable-prefix.js";

test("prepareCodexStablePrefix stabilizes instructions and developer prompt while isolating dynamic developer context", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const envelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Your working directory is: /repo/demo",
      "Runtime: agent=agent-123 | mode=interactive",
    ].join("\n"),
    messages: [
      {
        role: "system" as const,
        content: [
          "You are the coding agent.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 | mode=interactive",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  };

  const prepared = prepareCodexStablePrefix(envelope, config);

  assert.notEqual(prepared, envelope);
  assert.match(String(prepared.instructions ?? ""), /Your working directory is: \/repo\/demo/);
  assert.doesNotMatch(String(prepared.instructions ?? ""), /WORKDIR: \/repo\/demo/);
  assert.match(String(prepared.messages[0]?.content ?? ""), /Your working directory is: \/repo\/demo/);
  assert.doesNotMatch(String(prepared.messages[0]?.content ?? ""), /WORKDIR: \/repo\/demo/);
  assert.equal(prepared.messages.length, 3);
  assert.equal(prepared.messages[1]?.role, "system");
  assert.equal((prepared.messages[1] as any)?.metadata?.__codexOriginalRole, "developer");
  assert.match(String(prepared.messages[1]?.content ?? ""), /WORKDIR: \/repo\/demo/);
  assert.match(String(prepared.messages[1]?.content ?? ""), /AGENT_ID: agent-123/);
  assert.match(String(prepared.metadata?.promptCacheKey ?? ""), /^lightmem2-codex-/);
  assert.equal(prepared.metadata?.promptCacheRetention, "24h");
});

test("prepareCodexStablePrefix derives different cache keys for different stable prefixes", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "user",
    },
  });

  const baseEnvelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: "You are the coding agent.\nYour working directory is: /repo/demo",
    messages: [
      {
        role: "system" as const,
        content: "Project A rules.\nYour working directory is: /repo/demo",
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  };

  const preparedA = prepareCodexStablePrefix(baseEnvelope, config);
  const preparedB = prepareCodexStablePrefix({
    ...baseEnvelope,
    messages: [
      {
        ...baseEnvelope.messages[0],
        content: "Project B rules.\nYour working directory is: /repo/demo",
      },
      baseEnvelope.messages[1],
    ],
  }, config);

  assert.notEqual(preparedA.metadata?.promptCacheKey, preparedB.metadata?.promptCacheKey);
});

test("prepareCodexStablePrefix merges dynamic context from instructions and developer prompt", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const prepared = prepareCodexStablePrefix({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-merge-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Current date: 2026-07-08",
    ].join("\n"),
    messages: [
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 |",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  }, config);

  assert.equal(prepared.messages.length, 3);
  assert.match(String(prepared.messages[1]?.content ?? ""), /Current date: 2026-07-08/);
  assert.match(String(prepared.messages[1]?.content ?? ""), /WORKDIR: \/repo\/demo/);
  assert.match(String(prepared.messages[1]?.content ?? ""), /AGENT_ID: agent-123/);
});

test("prepareCodexStablePrefix prefers developer root prompt over generic system prompt", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const prepared = prepareCodexStablePrefix({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-root-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: "You are the coding agent.",
    messages: [
      {
        role: "system" as const,
        content: "Generic system note.",
        metadata: {
          __codexOriginalRole: "system",
        },
      },
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 |",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  }, config);

  assert.equal(String(prepared.messages[0]?.content ?? ""), "Generic system note.");
  assert.equal(String(prepared.messages[1]?.content ?? ""), [
    "Developer policy.",
    "Your working directory is: /repo/demo",
  ].join("\n"));
  assert.equal(prepared.messages[2]?.role, "system");
  assert.match(String(prepared.messages[2]?.content ?? ""), /WORKDIR: \/repo\/demo/);
  assert.match(String(prepared.messages[2]?.content ?? ""), /AGENT_ID: agent-123/);
});

test("prepareCodexStablePrefix keeps cache keys stable across volatile Codex runtime metadata", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const makeEnvelope = (params: { date: string; agentId: string; requestId: string; traceId: string }) => ({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-stable-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      `Current date: ${params.date}`,
      "Repository policy: keep commits small.",
    ].join("\n"),
    messages: [
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          `Runtime: agent=${params.agentId} | mode=interactive | request_id=${params.requestId} | trace_id=${params.traceId}`,
          "Always cite touched files.",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  });

  const preparedA = prepareCodexStablePrefix(makeEnvelope({
    date: "2026-07-08",
    agentId: "agent-123",
    requestId: "req_12345678901234567890",
    traceId: "trace_12345678901234567890",
  }), config);
  const preparedB = prepareCodexStablePrefix(makeEnvelope({
    date: "2026-07-09",
    agentId: "agent-999",
    requestId: "req_99999999999999999999",
    traceId: "trace_99999999999999999999",
  }), config);

  assert.equal(preparedA.metadata?.promptCacheKey, preparedB.metadata?.promptCacheKey);
  assert.match(String(preparedA.messages[1]?.content ?? ""), /Current date: 2026-07-08/);
  assert.match(String(preparedB.messages[1]?.content ?? ""), /Current date: 2026-07-09/);
  assert.match(String(preparedA.messages[1]?.content ?? ""), /request_id=req_12345678901234567890/i);
  assert.match(String(preparedB.messages[1]?.content ?? ""), /request_id=req_99999999999999999999/i);
});

test("prepareCodexStablePrefix injects merged dynamic context into first user message when target=user", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "user",
    },
  });

  const prepared = prepareCodexStablePrefix({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-user-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Current date: 2026-07-08",
      "Project policy: keep commits small.",
    ].join("\n"),
    messages: [
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 | request_id=req_12345678901234567890",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "please inspect the repo",
      },
    ],
    rawPayload: {},
    metadata: {},
  }, config);

  assert.equal(prepared.messages.length, 2);
  assert.match(String(prepared.messages[1]?.content ?? ""), /WORKDIR: \/repo\/demo/);
  assert.match(String(prepared.messages[1]?.content ?? ""), /AGENT_ID: agent-123/);
  assert.match(String(prepared.messages[1]?.content ?? ""), /Current date: 2026-07-08/);
  assert.match(String(prepared.messages[1]?.content ?? ""), /request_id=req_12345678901234567890/i);
  assert.match(String(prepared.messages[1]?.content ?? ""), /please inspect the repo/);
});

test("prepareCodexStablePrefix overrides inbound prompt_cache_key when one is already present", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const prepared = prepareCodexStablePrefix({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-preserve-key-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: "You are the coding agent.\nYour working directory is: /repo/demo",
    messages: [
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 | mode=interactive",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {
      promptCacheKey: "upstream-existing-key",
    },
  }, config);

  assert.match(String(prepared.metadata?.promptCacheKey ?? ""), /^lightmem2-codex-/);
  assert.notEqual(prepared.metadata?.promptCacheKey, "upstream-existing-key");
  assert.equal(prepared.metadata?.promptCacheRetention, "24h");
});

test("prepareCodexStablePrefix converges different inbound prompt_cache_key values onto the same stable key", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const makeEnvelope = (promptCacheKey: string) => ({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-converge-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: "You are the coding agent.\nYour working directory is: /repo/demo",
    messages: [
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 | mode=interactive",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {
      promptCacheKey,
    },
  });

  const preparedA = prepareCodexStablePrefix(makeEnvelope("legacy-key-a"), config);
  const preparedB = prepareCodexStablePrefix(makeEnvelope("legacy-key-b"), config);

  assert.equal(preparedA.metadata?.promptCacheKey, preparedB.metadata?.promptCacheKey);
  assert.match(String(preparedA.metadata?.promptCacheKey ?? ""), /^lightmem2-codex-/);
});
