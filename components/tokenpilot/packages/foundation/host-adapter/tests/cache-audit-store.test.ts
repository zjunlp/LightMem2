import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendCacheAuditRecord,
  buildCacheAuditSnapshot,
  readRecentCacheAuditRecordsForSession,
} from "../src/state/cache-audit.js";
import type { HostRequestEnvelope } from "../src/model/host-request.js";

function envelope(params: {
  sessionId: string;
  instructions: string;
  requestPromptCacheKey: string;
}): {
  envelope: HostRequestEnvelope;
  sessionId: string;
  requestPromptCacheKey: string;
} {
  return {
    sessionId: params.sessionId,
    requestPromptCacheKey: params.requestPromptCacheKey,
    envelope: {
      session: {
        host: { hostId: "codex", displayName: "Codex" },
        sessionId: params.sessionId,
        sessionMode: "single",
      },
      model: "gpt-5.4",
      stream: false,
      instructions: params.instructions,
      messages: [
        {
          role: "user",
          content: "hello",
        },
      ],
      rawPayload: {},
      metadata: {
        promptCacheKey: params.requestPromptCacheKey,
      },
    },
  };
}

test("appendCacheAuditRecord does not invent drift for a new request key in the same session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-cache-audit-store-"));
  try {
    const first = envelope({
      sessionId: "sess-drift-1",
      requestPromptCacheKey: "pk-a",
      instructions: "Project A rules.\nYour working directory is: /repo/demo",
    });
    const second = envelope({
      sessionId: "sess-drift-1",
      requestPromptCacheKey: "pk-b",
      instructions: "Project B rules.\nYour working directory is: /repo/demo",
    });

    await appendCacheAuditRecord({
      stateDir,
      snapshot: buildCacheAuditSnapshot({
        envelope: first.envelope,
        sessionId: first.sessionId,
        model: "gpt-5.4",
        stream: false,
        requestPromptCacheKey: first.requestPromptCacheKey,
      }),
      responsePromptCacheKey: first.requestPromptCacheKey,
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 } },
      status: 200,
    });

    await appendCacheAuditRecord({
      stateDir,
      snapshot: buildCacheAuditSnapshot({
        envelope: second.envelope,
        sessionId: second.sessionId,
        model: "gpt-5.4",
        stream: false,
        requestPromptCacheKey: second.requestPromptCacheKey,
      }),
      responsePromptCacheKey: second.requestPromptCacheKey,
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 } },
      status: 200,
    });

    const records = await readRecentCacheAuditRecordsForSession(stateDir, "sess-drift-1", 8);
    assert.equal(records.length, 2);
    assert.equal(records[0]?.originalRequestPromptCacheKey, null);
    assert.equal(records[0]?.requestPromptCacheKey, "pk-b");
    assert.equal(records[0]?.baselineKind, "none");
    assert.equal(records[0]?.driftReasons?.length ?? 0, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("appendCacheAuditRecord stores per-session records and keeps same-key baseline", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-cache-audit-store-"));
  try {
    const first = envelope({
      sessionId: "sess-same-key-1",
      requestPromptCacheKey: "pk-z",
      instructions: "Project A rules.\nYour working directory is: /repo/demo",
    });
    const second = envelope({
      sessionId: "sess-same-key-1",
      requestPromptCacheKey: "pk-z",
      instructions: "Project B rules.\nYour working directory is: /repo/demo",
    });

    await appendCacheAuditRecord({
      stateDir,
      snapshot: buildCacheAuditSnapshot({
        envelope: first.envelope,
        sessionId: first.sessionId,
        model: "gpt-5.4",
        stream: false,
        requestPromptCacheKey: first.requestPromptCacheKey,
      }),
      responsePromptCacheKey: first.requestPromptCacheKey,
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 } },
      status: 200,
    });

    await appendCacheAuditRecord({
      stateDir,
      snapshot: buildCacheAuditSnapshot({
        envelope: second.envelope,
        sessionId: second.sessionId,
        model: "gpt-5.4",
        stream: false,
        requestPromptCacheKey: second.requestPromptCacheKey,
      }),
      responsePromptCacheKey: second.requestPromptCacheKey,
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 } },
      status: 200,
    });

    const records = await readRecentCacheAuditRecordsForSession(stateDir, "sess-same-key-1", 8);
    assert.equal(records.length, 2);
    assert.equal(records[0]?.originalRequestPromptCacheKey, null);
    assert.equal(records[0]?.baselineKind, "request_key");
    assert.equal(records[0]?.driftReasons?.[0]?.key, "instructions");
    assert.equal(records[0]?.driftReasons?.[0]?.kind, "segment_text_changed");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
