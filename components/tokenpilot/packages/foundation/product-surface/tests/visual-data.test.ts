import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendReductionVisualSnapshot,
  readVisualSessionData,
  readVisualSessionDataWithOptions,
  readVisualSessionList,
  readVisualSessionListWithOptions,
} from "../src/visual/session-visual-data.js";

test("readVisualSessionData returns reduction snapshot route and ux aggregate", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpilot-product-surface-visual-"));
  try {
    const stateDir = root;
    const sessionId = "session-1";

    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-02T12:00:00.000Z",
      sessionId,
      requestId: "req-1",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "seg-1",
      itemIndex: 0,
      field: "output",
      toolName: "read",
      dataPath: "/repo/README.md",
      savedChars: 320,
      route: "readme_doc",
      routeReason: "readme_path_hint",
      passSavedChars: {
        tool_payload_trim: 300,
        read_state_compaction: 20,
      },
      beforeText: "before",
      afterText: "after",
      report: [],
    });
    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-02T12:00:01.000Z",
      sessionId,
      requestId: "req-1",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "seg-1",
      itemIndex: 0,
      field: "output",
      toolName: "read",
      dataPath: "/repo/README.md",
      savedChars: 320,
      route: "readme_doc",
      routeReason: "readme_path_hint",
      passSavedChars: {
        tool_payload_trim: 300,
        read_state_compaction: 20,
      },
      beforeText: "before",
      afterText: "after",
      report: [],
    });
    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-02T12:00:02.000Z",
      sessionId,
      requestId: "req-1",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "seg-2",
      itemIndex: 1,
      field: "output",
      toolName: "read",
      dataPath: "/repo/src/app.ts",
      savedChars: 180,
      route: "code_like",
      routeReason: "code_fence",
      passSavedChars: {
        tool_payload_trim: 180,
      },
      beforeText: "before-2",
      afterText: "after-2",
      report: [],
    });
    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-02T12:00:03.000Z",
      sessionId,
      requestId: "req-2",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "seg-3",
      itemIndex: 0,
      field: "output",
      toolName: "grep",
      dataPath: "/repo/log.txt",
      savedChars: 90,
      route: "logs",
      routeReason: "stderr_log",
      passSavedChars: {
        tool_payload_trim: 90,
      },
      beforeText: "before-3",
      afterText: "after-3",
      report: [],
    });

    const aggregatePath = join(stateDir, "tokenpilot", "ux-effects", "sessions", `${sessionId}.json`);
    await mkdir(join(stateDir, "tokenpilot", "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(stateDir, "tokenpilot", "ux-effects", "history.jsonl"),
      `${JSON.stringify({
        sessionId,
        details: {
          routeSavedChars: { readme_doc: 320 },
          routeHitCount: { readme_doc: 1 },
          passSavedChars: { tool_payload_trim: 300, read_state_compaction: 20 },
        },
      })}\n`,
    );
    await writeFile(aggregatePath, JSON.stringify({
      sessionId,
      turns: 3,
      latestCountMode: "chars",
      charOptimizedTurns: 2,
      charSavedCount: 640,
      avgSavedCharsPerOptimizedTurn: 320,
      passSavedChars: { tool_payload_trim: 500 },
      routeSavedChars: { readme_doc: 640 },
      routeHitCount: { readme_doc: 2 },
    }, null, 2));
    await writeFile(
      join(stateDir, "cache-audit.jsonl"),
      [
        JSON.stringify({
          at: "2026-07-02T12:00:00.000Z",
          sessionId,
          model: "gpt-5.4",
          stream: false,
          stablePrefixFingerprint: "fp-1",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [{ kind: "abs_path", segmentKey: "instructions", layer: "stable_core", detail: "path" }],
          driftReasons: [{ kind: "segment_text_changed", key: "instructions", detail: "changed" }],
          originalRequestPromptCacheKey: "host-pk-1",
          requestPromptCacheKey: "pk-1",
          responsePromptCacheKey: "pk-1",
          cachedInputTokens: 0,
          usage: { input_tokens: 100 },
          status: 200,
        }),
        JSON.stringify({
          at: "2026-07-02T12:01:00.000Z",
          sessionId,
          model: "gpt-5.4",
          stream: false,
          stablePrefixFingerprint: "fp-1",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [{ kind: "abs_path", segmentKey: "instructions", layer: "stable_core", detail: "path" }],
          driftReasons: [{ kind: "segment_text_changed", key: "instructions", detail: "changed" }],
          originalRequestPromptCacheKey: "host-pk-2",
          requestPromptCacheKey: "pk-1",
          responsePromptCacheKey: "pk-2",
          cachedInputTokens: 64,
          usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 } },
          status: 200,
        }),
      ].join("\n"),
    );

    const data = await readVisualSessionData(stateDir, sessionId);
    assert.equal(data.reduction.length, 3);
    assert.equal(data.reduction[0]?.route, "logs");
    assert.equal(data.reduction[1]?.route, "code_like");
    assert.equal(data.reduction[2]?.routeReason, "readme_path_hint");
    assert.equal(data.reductionCalls?.length, 2);
    assert.equal(data.reductionCalls?.[0]?.requestId, "req-2");
    assert.equal(data.reductionCalls?.[0]?.segmentCount, 1);
    assert.equal(data.reductionCalls?.[0]?.totalSavedChars, 90);
    assert.equal(data.reductionCalls?.[1]?.requestId, "req-1");
    assert.equal(data.reductionCalls?.[1]?.segmentCount, 2);
    assert.equal(data.reductionCalls?.[1]?.totalSavedChars, 500);
    assert.equal(data.reductionCalls?.[1]?.toolNames.join(","), "read");
    assert.equal(data.reductionCalls?.[1]?.routes.join(","), "code_like,readme_doc");
    assert.equal(data.reductionCalls?.[1]?.segments[0]?.segmentId, "seg-2");
    assert.equal(data.reductionCalls?.[1]?.segments[0]?.itemIndex, 1);
    assert.equal(data.reductionCalls?.[1]?.segments[1]?.segmentId, "seg-1");
    assert.equal(data.uxAggregate?.charSavedCount, 640);
    assert.equal(data.uxAggregate?.routeSavedChars?.readme_doc, 640);
    assert.equal(data.recentReduction?.totalSavedChars, 320);
    assert.equal(data.recentReduction?.dominantRoute?.key, "readme_doc");
    assert.equal(data.recentReduction?.dominantPass?.key, "tool_payload_trim");
    assert.equal(data.cacheAuditSummary?.warmCandidates, 1);
    assert.equal(data.cacheAuditSummary?.warmHits, 1);
    assert.equal(data.cacheAuditSummary?.responsePromptCacheKeyRewriteCount, 1);
    assert.equal(data.cacheAuditSummary?.promptCacheKeyMismatchCount, 1);
    assert.equal(data.recentCacheAudit?.length, 2);
    assert.equal(data.recentCacheAudit?.[0]?.cachedInputTokens, 64);
    assert.equal(data.recentCacheAudit?.[0]?.originalRequestPromptCacheKey, "host-pk-2");
    assert.equal(data.recentCacheAudit?.[0]?.requestPromptCacheKey, "pk-1");
    assert.equal(data.recentCacheAudit?.[0]?.responsePromptCacheKey, "pk-2");
    assert.equal(data.recentCacheAudit?.[0]?.entropyKinds[0], "abs_path");
    assert.equal(data.recentCacheAudit?.[0]?.driftKeys[0], "instructions");
    assert.equal(data.recentCacheAudit?.[0]?.diagnosis.matchedResult, "warm hit");
    assert.equal(data.recentCacheAudit?.[0]?.diagnosis.rewriteDetected, true);
    assert.equal((data.recentCacheAudit?.[0]?.diagnosis.killers.length ?? 0) > 0, true);
    assert.equal((data.recentCacheAudit?.[0]?.diagnosis.harnessRules.length ?? 0) > 0, true);
    assert.equal(data.recentCacheAuditGroups?.length, 1);
    assert.equal(data.recentCacheAuditGroups?.[0]?.requestCount, 2);
    assert.equal(data.recentCacheAuditGroups?.[0]?.warmHitCount, 1);
    assert.equal(data.recentCacheAuditGroups?.[0]?.rewriteCount, 1);
    assert.equal(data.recentCacheAuditGroups?.[0]?.originalRequestPromptCacheKeys.join(","), "host-pk-2,host-pk-1");
    assert.equal(data.recentCacheAuditGroups?.[0]?.stablePrefixFingerprint, "fp-1");
    const sessions = await readVisualSessionList(stateDir);
    assert.equal(sessions[0]?.latestCountMode, "chars");
    assert.equal(sessions[0]?.charSavedCount, 640);
    assert.equal(sessions[0]?.reductionCount, 2);
    assert.equal(sessions[0]?.cacheAuditSummary?.warmHits, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readVisualSessionData orders same-call segments by later item position when timestamps tie", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpilot-product-surface-visual-call-order-"));
  try {
    const stateDir = root;
    const sessionId = "session-order";
    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-09T17:35:40.148Z",
      sessionId,
      requestId: "req-order-1",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "input-33-output",
      itemIndex: 33,
      field: "output",
      savedChars: 80,
      beforeText: "before-33",
      afterText: "after-33",
      report: [],
    });
    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-09T17:35:40.148Z",
      sessionId,
      requestId: "req-order-1",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "input-41-output",
      itemIndex: 41,
      field: "output",
      savedChars: 10,
      beforeText: "before-41",
      afterText: "after-41",
      report: [],
    });
    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-09T17:35:40.148Z",
      sessionId,
      requestId: "req-order-1",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "input-40-output",
      itemIndex: 40,
      field: "output",
      savedChars: 200,
      beforeText: "before-40",
      afterText: "after-40",
      report: [],
    });

    const data = await readVisualSessionData(stateDir, sessionId);
    assert.equal(data.reductionCalls?.length, 1);
    assert.deepEqual(
      data.reductionCalls?.[0]?.segments.map((segment) => segment.segmentId),
      ["input-41-output", "input-40-output", "input-33-output"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readVisualSessionDataWithOptions limits returned stability, reduction calls, and eviction items", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpilot-product-surface-visual-limits-"));
  try {
    const stateDir = root;
    const sessionId = "session-limit";
    await mkdir(join(stateDir, "tokenpilot", "visual", "stability"), { recursive: true });
    await mkdir(join(stateDir, "tokenpilot", "visual", "eviction"), { recursive: true });
    await writeFile(
      join(stateDir, "tokenpilot", "visual", "stability", `${sessionId}.jsonl`),
      [
        {
          kind: "stability",
          at: "2026-07-07T10:00:00.000Z",
          sessionId,
          model: "gpt-5.4",
          upstreamModel: "gpt-5.4",
          promptCacheKeyBefore: "a",
          promptCacheKeyAfter: "b",
          dynamicContextTarget: "developer",
          userContentRewrites: 0,
          senderMetadataBlocksBefore: 0,
          senderMetadataBlocksAfter: 0,
          developerBefore: "before-1",
          developerCanonical: "canonical-1",
          developerForwarded: "forwarded-1",
          firstTurnCandidate: true,
        },
        {
          kind: "stability",
          at: "2026-07-07T10:01:00.000Z",
          sessionId,
          model: "gpt-5.4",
          upstreamModel: "gpt-5.4",
          promptCacheKeyBefore: "c",
          promptCacheKeyAfter: "d",
          dynamicContextTarget: "developer",
          userContentRewrites: 0,
          senderMetadataBlocksBefore: 0,
          senderMetadataBlocksAfter: 0,
          developerBefore: "before-2",
          developerCanonical: "canonical-2",
          developerForwarded: "forwarded-2",
          firstTurnCandidate: false,
        },
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8",
    );
    await writeFile(
      join(stateDir, "tokenpilot", "visual", "eviction", `${sessionId}.jsonl`),
      [
        {
          kind: "eviction",
          at: "2026-07-07T10:00:00.000Z",
          sessionId,
          taskId: "task-1",
          replacementMode: "pointer_stub",
          beforeText: "before-1",
          afterText: "after-1",
          beforeChars: 10,
          afterChars: 2,
          archivePath: "/tmp/archive-1",
          dataKey: "data-1",
          turnAbsIds: ["t1"],
        },
        {
          kind: "eviction",
          at: "2026-07-07T10:02:00.000Z",
          sessionId,
          taskId: "task-2",
          replacementMode: "pointer_stub",
          beforeText: "before-2",
          afterText: "after-2",
          beforeChars: 12,
          afterChars: 3,
          archivePath: "/tmp/archive-2",
          dataKey: "data-2",
          turnAbsIds: ["t2"],
        },
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8",
    );
    for (let index = 0; index < 3; index += 1) {
      await appendReductionVisualSnapshot(stateDir, {
        kind: "reduction",
        at: `2026-07-07T10:0${index}:30.000Z`,
        sessionId,
        requestId: `req-${index}`,
        model: "gpt-5.4",
        upstreamModel: "gpt-5.4",
        segmentId: `seg-${index}`,
        itemIndex: index,
        field: "output",
        savedChars: 10 + index,
        beforeText: `before-${index}`,
        afterText: `after-${index}`,
        report: [],
      });
    }

    const data = await readVisualSessionDataWithOptions(stateDir, sessionId, {
      stabilityLimit: 1,
      reductionCallLimit: 2,
      evictionLimit: 1,
    });
    assert.equal(data.stability.length, 1);
    assert.equal(data.reductionCalls?.length, 2);
    assert.equal(data.reduction.length, 2);
    assert.equal(data.eviction.length, 1);
    assert.equal(data.limits?.stabilityTotal, 2);
    assert.equal(data.limits?.stabilityReturned, 1);
    assert.equal(data.limits?.reductionCallTotal, 3);
    assert.equal(data.limits?.reductionCallReturned, 2);
    assert.equal(data.limits?.evictionTotal, 2);
    assert.equal(data.limits?.evictionReturned, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readVisualSessionData keeps a larger cache-audit matching window than the rendered recent list", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpilot-product-surface-visual-cache-window-"));
  try {
    const stateDir = root;
    const sessionId = "session-cache-window";
    await writeFile(
      join(stateDir, "cache-audit.jsonl"),
      Array.from({ length: 12 }, (_item, index) => JSON.stringify({
        at: `2026-07-07T12:${String(index).padStart(2, "0")}:00.000Z`,
        sessionId,
        model: "gpt-5.4",
        stream: false,
        stablePrefixFingerprint: `fp-${index}`,
        stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
        entropyFindings: [],
        driftReasons: [],
        requestPromptCacheKey: `pk-${index}`,
        responsePromptCacheKey: `pk-${index}`,
        cachedInputTokens: index === 11 ? 64 : 0,
        usage: { input_tokens: 100 },
        status: 200,
      })).join("\n"),
    );

    const data = await readVisualSessionData(stateDir, sessionId);
    assert.equal(data.cacheAuditWindow?.length, 12);
    assert.equal(data.recentCacheAudit?.length, 8);
    assert.equal(data.cacheAuditWindow?.[0]?.requestPromptCacheKey, "pk-11");
    assert.equal(data.cacheAuditWindow?.[11]?.requestPromptCacheKey, "pk-0");
    assert.equal(data.recentCacheAudit?.[0]?.requestPromptCacheKey, "pk-11");
    assert.equal(data.recentCacheAudit?.[7]?.requestPromptCacheKey, "pk-4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readVisualSessionListWithOptions paginates ordered sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpilot-product-surface-visual-session-page-"));
  try {
    const stateDir = root;
    await mkdir(join(stateDir, "tokenpilot", "visual", "reduction"), { recursive: true });
    for (let index = 0; index < 3; index += 1) {
      const sessionId = `session-${index}`;
      await writeFile(
        join(stateDir, "tokenpilot", "visual", "reduction", `${sessionId}.jsonl`),
        `${JSON.stringify({
          kind: "reduction",
          at: `2026-07-07T10:0${index}:00.000Z`,
          sessionId,
          requestId: `req-${index}`,
          model: "gpt-5.4",
          upstreamModel: "gpt-5.4",
          segmentId: `seg-${index}`,
          itemIndex: index,
          field: "content",
          savedChars: index + 1,
          beforeText: "before",
          afterText: "after",
          report: [],
        })}\n`,
        "utf8",
      );
    }
    const page = await readVisualSessionListWithOptions(stateDir, { limit: 2, offset: 0 });
    assert.equal(page.total, 3);
    assert.equal(page.sessions.length, 2);
    assert.deepEqual(page.sessions.map((session) => session.sessionId), ["session-2", "session-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readVisualSessionData and readVisualSessionList keep session cache-audit summaries when other sessions are newer", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpilot-product-surface-visual-cache-session-"));
  try {
    const stateDir = root;
    const targetSessionId = "session-target";
    const noisySessionId = "session-noisy";
    await writeFile(
      join(stateDir, "cache-audit.jsonl"),
      [
        JSON.stringify({
          at: "2026-07-02T12:00:00.000Z",
          sessionId: targetSessionId,
          model: "gpt-5.4",
          stream: false,
          stablePrefixFingerprint: "fp-target",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [],
          driftReasons: [],
          requestPromptCacheKey: "pk-target",
          responsePromptCacheKey: "pk-target",
          cachedInputTokens: 0,
          usage: { input_tokens: 100 },
          status: 200,
        }),
        JSON.stringify({
          at: "2026-07-02T12:01:00.000Z",
          sessionId: targetSessionId,
          model: "gpt-5.4",
          stream: false,
          stablePrefixFingerprint: "fp-target",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [],
          driftReasons: [],
          requestPromptCacheKey: "pk-target",
          responsePromptCacheKey: "pk-target",
          cachedInputTokens: 64,
          usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 } },
          status: 200,
        }),
        ...Array.from({ length: 80 }, (_item, index) => JSON.stringify({
          at: `2026-07-02T12:${String(index + 2).padStart(2, "0")}:00.000Z`,
          sessionId: noisySessionId,
          model: "gpt-5.4",
          stream: false,
          stablePrefixFingerprint: `fp-noisy-${index}`,
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [],
          driftReasons: [],
          requestPromptCacheKey: `pk-noisy-${index}`,
          responsePromptCacheKey: `pk-noisy-${index}`,
          cachedInputTokens: 0,
          usage: { input_tokens: 100 },
          status: 200,
        })),
      ].join("\n"),
    );
    await mkdir(join(stateDir, "tokenpilot", "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(stateDir, "tokenpilot", "ux-effects", "sessions", `${targetSessionId}.json`),
      JSON.stringify({ sessionId: targetSessionId, latestAt: "2026-07-02T12:01:00.000Z" }),
    );
    await writeFile(
      join(stateDir, "tokenpilot", "ux-effects", "sessions", `${noisySessionId}.json`),
      JSON.stringify({ sessionId: noisySessionId, latestAt: "2026-07-02T13:59:00.000Z" }),
    );
    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-02T12:01:00.000Z",
      sessionId: targetSessionId,
      requestId: "req-target",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "seg-target",
      itemIndex: 0,
      field: "output",
      savedChars: 10,
      beforeText: "before",
      afterText: "after",
      report: [],
    });

    const data = await readVisualSessionData(stateDir, targetSessionId);
    assert.equal(data.cacheAuditSummary?.warmCandidates, 1);
    assert.equal(data.cacheAuditSummary?.warmHits, 1);
    assert.equal(data.recentCacheAudit?.length, 2);

    const sessions = await readVisualSessionList(stateDir);
    const target = sessions.find((session) => session.sessionId === targetSessionId);
    assert.equal(target?.cacheAuditSummary?.warmCandidates, 1);
    assert.equal(target?.cacheAuditSummary?.warmHits, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
