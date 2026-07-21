import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildVisualRequestId,
  writeReductionVisualSegments,
  writeStabilityVisualSnapshot,
  readVisualSessionData,
  readVisualSessionList,
  startMultiHostVisualServer,
  type ReductionVisualSnapshot,
} from "../src/index.js";
import { registerTestCacheAuditContribution } from "./cache-audit-contribution-fixture.js";

registerTestCacheAuditContribution();

test("visual bridge helpers persist shared stability and reduction snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenpilot-visual-bridge-"));
  try {
    const stateDir = join(dir, "codex");
    const requestId = buildVisualRequestId(["bridge", "session-1", 1]);
    await writeStabilityVisualSnapshot({
      stateDir,
      snapshot: {
        kind: "stability",
        at: "2026-06-29T12:00:00.000Z",
        sessionId: "session-1",
        model: "gpt-5.4-mini",
        upstreamModel: "gpt-5.4-mini",
        promptCacheKeyBefore: "",
        promptCacheKeyAfter: "pk-1",
        dynamicContextTarget: "user",
        userContentRewrites: 1,
        senderMetadataBlocksBefore: 0,
        senderMetadataBlocksAfter: 0,
        developerBefore: "Your working directory is: /repo/demo",
        developerCanonical: "Your working directory is: <WORKDIR>",
        developerForwarded: "Your working directory is: <WORKDIR>",
        dynamicContextText: "- WORKDIR: /repo/demo",
        firstTurnCandidate: true,
      },
    });
    await writeReductionVisualSegments({
      stateDir,
      at: "2026-06-29T12:00:01.000Z",
      sessionId: "session-1",
      requestId,
      model: "gpt-5.4-mini",
      upstreamModel: "gpt-5.4-mini",
      segments: [
        {
          segmentId: "seg-1",
          itemIndex: 0,
          field: "content",
          savedChars: 123,
          beforeText: "before",
          afterText: "after",
          report: [],
        },
      ],
    });

    const sessions = await readVisualSessionList(stateDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, "session-1");
    assert.equal(sessions[0]?.stabilityCount, 1);
    assert.equal(sessions[0]?.reductionCount, 1);

    const data = await readVisualSessionData(stateDir, "session-1");
    assert.equal(data.stability[0]?.promptCacheKeyAfter, "pk-1");
    assert.equal(data.reduction[0]?.requestId, requestId);
    assert.equal(data.reduction[0]?.savedChars, 123);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("multi-host visual server exposes hosts and host-scoped sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenpilot-multi-host-visual-"));
  try {
    const openclawStateDir = join(dir, "openclaw");
    const codexStateDir = join(dir, "codex");
    await mkdir(join(openclawStateDir, "tokenpilot", "visual", "reduction"), { recursive: true });
    await mkdir(join(codexStateDir, "tokenpilot", "visual", "reduction"), { recursive: true });

    const openclawSnapshot: ReductionVisualSnapshot = {
      kind: "reduction",
      at: "2026-06-29T10:00:00.000Z",
      sessionId: "openclaw-session-1",
      requestId: "req-openclaw-1",
      model: "gpt-5.4-mini",
      upstreamModel: "gpt-5.4-mini",
      segmentId: "seg-openclaw-1",
      itemIndex: 0,
      field: "content",
      savedChars: 111,
      beforeText: "before-openclaw",
      afterText: "after-openclaw",
      report: [],
    };
    const codexSnapshot: ReductionVisualSnapshot = {
      kind: "reduction",
      at: "2026-06-29T11:00:00.000Z",
      sessionId: "codex-session-1",
      requestId: "req-codex-1",
      model: "gpt-5.4-mini",
      upstreamModel: "gpt-5.4-mini",
      segmentId: "seg-codex-1",
      itemIndex: 0,
      field: "content",
      savedChars: 222,
      beforeText: "before-codex",
      afterText: "after-codex",
      report: [],
    };

    await writeFile(
      join(openclawStateDir, "tokenpilot", "visual", "reduction", "openclaw-session-1.jsonl"),
      `${JSON.stringify(openclawSnapshot)}\n`,
      "utf8",
    );
    await mkdir(join(openclawStateDir, "tokenpilot", "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(openclawStateDir, "tokenpilot", "ux-effects", "sessions", "openclaw-session-1.json"),
      `${JSON.stringify({
        sessionId: "openclaw-session-1",
        latestCountMode: "chars",
        charOptimizedTurns: 1,
        charSavedCount: 111,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(codexStateDir, "tokenpilot", "visual", "reduction", "codex-session-1.jsonl"),
      `${JSON.stringify(codexSnapshot)}\n`,
      "utf8",
    );
    await mkdir(join(codexStateDir, "tokenpilot", "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(codexStateDir, "tokenpilot", "ux-effects", "sessions", "codex-session-1.json"),
      `${JSON.stringify({
        sessionId: "codex-session-1",
        latestCountMode: "openai_tokens",
        tokenOptimizedTurns: 1,
        tokenSavedCount: 222,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(codexStateDir, "cache-audit.jsonl"),
      [
        JSON.stringify({
          at: "2026-06-29T11:00:00.000Z",
          sessionId: "codex-session-1",
          model: "gpt-5.4-mini",
          stream: false,
          stablePrefixFingerprint: "fp-codex-1",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [{ kind: "abs_path", segmentKey: "instructions", layer: "stable_core", detail: "path" }],
          driftReasons: [{ kind: "segment_text_changed", key: "instructions", detail: "changed" }],
          originalRequestPromptCacheKey: "host-codex-1",
          requestPromptCacheKey: "pk-codex-1",
          responsePromptCacheKey: "pk-codex-1",
          cachedInputTokens: 0,
          usage: { input_tokens: 100 },
          status: 200,
        }),
        JSON.stringify({
          at: "2026-06-29T11:01:00.000Z",
          sessionId: "codex-session-1",
          model: "gpt-5.4-mini",
          stream: false,
          stablePrefixFingerprint: "fp-codex-1",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [{ kind: "uuid", segmentKey: "instructions", layer: "stable_core", detail: "uuid" }],
          driftReasons: [{ kind: "segment_text_changed", key: "tools", detail: "changed" }],
          originalRequestPromptCacheKey: "host-codex-2",
          requestPromptCacheKey: "pk-codex-1",
          responsePromptCacheKey: "pk-codex-2",
          cachedInputTokens: 64,
          usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 } },
          status: 200,
        }),
      ].join("\n"),
      "utf8",
    );

    const handle = await startMultiHostVisualServer([
      {
        hostId: "openclaw",
        displayName: "OpenClaw",
        stateDir: openclawStateDir,
      },
      {
        hostId: "codex",
        displayName: "Codex",
        stateDir: codexStateDir,
      },
    ]);

    try {
      const hostsResp = await fetch(`${handle.url}/api/hosts`);
      const hostsPayload = await hostsResp.json() as {
        hosts: Array<{
          hostId: string;
          displayName: string;
          sessionCount: number;
          stabilityCount: number;
          reductionCount: number;
          evictionCount: number;
          tokenSavedCount: number;
          charSavedCount: number;
          latestAt: string;
          cacheWarmCandidates: number;
          cacheWarmHits: number;
        }>;
      };
      assert.deepEqual(
        hostsPayload.hosts.map((host) => [
          host.hostId,
          host.sessionCount,
          host.stabilityCount,
          host.reductionCount,
          host.evictionCount,
          host.tokenSavedCount,
          host.charSavedCount,
        ]),
        [
          ["codex", 1, 0, 1, 0, 222, 0],
          ["openclaw", 1, 0, 1, 0, 0, 111],
        ],
      );
      assert.equal(hostsPayload.hosts[0]?.latestAt, "2026-06-29T11:00:00.000Z");
      assert.equal(hostsPayload.hosts[1]?.latestAt, "2026-06-29T10:00:00.000Z");
      assert.equal(hostsPayload.hosts[0]?.cacheWarmHits, 1);
      assert.equal(hostsPayload.hosts[0]?.cacheWarmCandidates, 1);
      assert.equal(hostsPayload.hosts[1]?.cacheWarmCandidates, 0);

      const openclawSessionsResp = await fetch(`${handle.url}/api/sessions?host=openclaw`);
      const openclawSessionsPayload = await openclawSessionsResp.json() as {
        hostId: string;
        sessions: Array<{ sessionId: string }>;
        total: number;
        limit: number;
      };
      assert.equal(openclawSessionsPayload.hostId, "openclaw");
      assert.equal(openclawSessionsPayload.total, 1);
      assert.equal(openclawSessionsPayload.limit, 10);
      assert.deepEqual(openclawSessionsPayload.sessions.map((session) => session.sessionId), ["openclaw-session-1"]);

      const codexSessionResp = await fetch(
        `${handle.url}/api/session?host=codex&sessionId=${encodeURIComponent("codex-session-1")}`,
      );
      const codexSessionPayload = await codexSessionResp.json() as {
        sessionId: string;
        reduction: Array<{ beforeText: string; afterText: string }>;
        reductionCalls?: Array<{ requestId: string }>;
        limits?: {
          reductionCallTotal: number;
          reductionCallReturned: number;
        };
        cacheAuditSummary?: {
          warmHits: number;
          warmCandidates: number;
          responsePromptCacheKeyRewriteCount: number;
        };
        recentCacheAudit?: Array<{
          cachedInputTokens: number;
          requestPromptCacheKey: string | null;
          responsePromptCacheKey: string | null;
        }>;
      };
      assert.equal(codexSessionPayload.sessionId, "codex-session-1");
      assert.equal(codexSessionPayload.reduction[0]?.beforeText, "before-codex");
      assert.equal(codexSessionPayload.reductionCalls?.length, 1);
      assert.equal(codexSessionPayload.limits?.reductionCallTotal, 1);
      assert.equal(codexSessionPayload.limits?.reductionCallReturned, 1);
      assert.equal(codexSessionPayload.cacheAuditSummary?.warmHits, 1);
      assert.equal(codexSessionPayload.cacheAuditSummary?.warmCandidates, 1);
      assert.equal(codexSessionPayload.cacheAuditSummary?.responsePromptCacheKeyRewriteCount, 1);
      assert.equal(codexSessionPayload.recentCacheAudit?.length, 2);
      assert.equal(codexSessionPayload.recentCacheAudit?.[0]?.cachedInputTokens, 64);
      assert.equal(codexSessionPayload.recentCacheAudit?.[0]?.requestPromptCacheKey, "pk-codex-1");
      assert.equal(codexSessionPayload.recentCacheAudit?.[0]?.responsePromptCacheKey, "pk-codex-2");
    } finally {
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
