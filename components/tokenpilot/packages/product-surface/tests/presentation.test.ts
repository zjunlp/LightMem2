import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { buildSessionReportText, formatSessionReport, loadSessionReportData, renderSessionReport } from "../src/presentation.js";
import { renderVisualPageHtml, renderVisualPageScript } from "../src/visual/session-visual-page.js";

test("formatSessionReport prefers char aggregates when latest mode is chars", () => {
  const text = formatSessionReport({
    sessionId: "session-char-1",
    aggregate: {
      turns: 6,
      latestCountMode: "chars",
      tokenOptimizedTurns: 1,
      tokenSavedCount: 1200,
      avgSavedTokensPerOptimizedTurn: 1200,
      charOptimizedTurns: 2,
      charSavedCount: 162795,
      avgSavedCharsPerOptimizedTurn: 81397.5,
    },
    latest: {
      countMode: "chars",
      details: {
        requestSavedCount: 80000,
        responseSavedCount: 1397,
      },
    },
    detailsEnabled: true,
    cacheAuditSummary: {
      warmCandidates: 2,
      warmHits: 1,
      warmMisses: 1,
      hitRatePercent: 50,
      responsePromptCacheKeyRewriteCount: 3,
      promptCacheKeyMismatchCount: 3,
      topEntropyKinds: [{ key: "abs_path", count: 2 }],
      topDriftKeys: [{ key: "instructions", count: 1 }],
    },
    latestNonWarmCacheDiagnosis: {
      at: "2026-07-08T10:01:00.000Z",
      matchedResult: "cold miss",
      driftKeys: ["instructions"],
      entropyKinds: [],
      currentState: "Cold miss: stable-prefix text drifted across requests.",
      optimizationHint: "Fingerprint drift: move volatile prompt fragments out of stable prefix, or shift them into dynamic context before the next request.",
    },
  });

  assert.match(text, /saved chars: 162,795/);
  assert.match(text, /count mode: chars fallback/);
  assert.match(text, /optimized turns: 2/);
  assert.match(text, /avg saved chars per optimized turn: 81,398/);
  assert.match(text, /latest request savings: 80,000 chars/);
  assert.match(text, /latest response savings: 1,397 chars/);
  assert.match(text, /cache warm hits: 1\/2 \(50%\)/);
  assert.match(text, /cache warm misses: 1/);
  assert.match(text, /response cache key rewrites: 3/);
  assert.match(text, /cache entropy hotspots: abs_path=2/);
  assert.match(text, /cache drift hotspots: instructions=1/);
  assert.match(text, /latest cold miss drift: instructions/);
  assert.match(text, /latest cold miss hint: Fingerprint drift/);
});

test("formatSessionReport falls back to token aggregates when latest mode is unset", () => {
  const text = formatSessionReport({
    sessionId: "session-token-1",
    aggregate: {
      turns: 5,
      latestCountMode: "openai_tokens",
      tokenOptimizedTurns: 3,
      tokenSavedCount: 4500,
      avgSavedTokensPerOptimizedTurn: 1500,
      charOptimizedTurns: 0,
      charSavedCount: 0,
      avgSavedCharsPerOptimizedTurn: 0,
    },
    latest: null,
    detailsEnabled: false,
  });

  assert.match(text, /saved tokens: 4,500/);
  assert.match(text, /count mode: precise OpenAI tokens/);
  assert.match(text, /optimized turns: 3/);
  assert.match(text, /avg saved tokens per optimized turn: 1,500/);
  assert.doesNotMatch(text, /latest request savings/);
});

test("renderVisualPageHtml includes core visual navigation structure", () => {
  const html = renderVisualPageHtml();

  assert.match(html, /<title>LightMem2 Visual<\/title>/);
  assert.match(html, /Loading sessions…/);
  assert.match(html, /Stability/);
  assert.match(html, /Reduction/);
  assert.match(html, /Eviction/);
  assert.match(html, /session-list/);
  assert.match(html, /overviewRoot/);
  assert.match(html, /compare/);
  assert.match(html, /hostSelect/);
  assert.match(html, /app\.js/);
});

test("renderVisualPageScript includes cache audit detail panel labels", () => {
  const script = renderVisualPageScript();

  assert.match(script, /Cache Audit/);
  assert.match(script, /Cache Stability/);
  assert.match(script, /Prefix Stability Snapshot/);
  assert.match(script, /prompt cache transition=/);
  assert.match(script, /matched fingerprint=/);
  assert.match(script, /matched result=/);
  assert.match(script, /rewrite detected=/);
  assert.match(script, /matched entropy=/);
  assert.match(script, /matched drift=/);
  assert.match(script, /optimization hint=/);
  assert.match(script, /Warm Cache Plan/);
  assert.match(script, /Cache Killer #/);
  assert.match(script, /harness fix=/);
  assert.match(script, /Harness Rule Hints/);
  assert.match(script, /rule '/);
  assert.match(script, /current state=/);
  assert.match(script, /target state=/);
  assert.match(script, /action '/);
  assert.match(script, /diff guide=/);
  assert.match(script, /Developer Before/);
  assert.match(script, /Developer Canonical/);
  assert.match(script, /Developer Forwarded/);
  assert.match(script, /Fingerprint Group #/);
  assert.match(script, /Recent Cache Request #/);
  assert.match(script, /No reduction segments in this call/);
  assert.match(script, /Before Selected Segment/);
  assert.match(script, /After Selected Segment/);
  assert.match(script, /Segments In This Call/);
  assert.match(script, /Selected Segment/);
  assert.match(script, /Latest segment/);
  assert.match(script, /latest segment #/);
  assert.match(script, /Reduction Call/);
  assert.match(script, /data-segment-index/);
  assert.match(script, /state\.activeTab === "reduction" \? "Call " : ""/);
  assert.match(script, /Segment #/);
  assert.match(script, /Show more sessions/);
  assert.match(script, /Show all sessions/);
  assert.match(script, /Show more calls/);
  assert.match(script, /Show all .* fingerprint groups/);
  assert.match(script, /Show fewer fingerprint groups/);
  assert.match(script, / · latest/);
  assert.match(script, /response key rewrites=/);
  assert.match(script, /latest cold start/);
  assert.match(script, /latest cold miss/);
  assert.match(script, /hint=/);
  assert.match(script, /fingerprint=/);
  assert.match(script, /request key=/);
  assert.match(script, /cached tokens=/);
  assert.match(script, /entropy hotspots=/);
  assert.match(script, /drift hotspots=/);
  assert.match(script, /Current Prompt -> Suggested Stable Shape/);
  assert.match(script, /Suggested Stable Shape -> Dynamic Tail Extraction/);
});

test("renderVisualPageScript is syntactically valid javascript", () => {
  const script = renderVisualPageScript();
  assert.doesNotThrow(() => new vm.Script(script));
});

test("buildSessionReportText renders empty-state reports with overview", () => {
  const text = buildSessionReportText({
    title: "TokenPilot Codex report:",
    sessionId: "session-empty",
    aggregate: null,
    latest: null,
    detailsEnabled: true,
    overview: [
      { label: "Session", value: "session-empty" },
      { label: "Model", value: "gpt-5.4" },
    ],
  });

  assert.match(text, /^Session: session-empty/m);
  assert.match(text, /^Model: gpt-5\.4/m);
  assert.match(text, /TokenPilot Codex report:/);
  assert.match(text, /- no savings recorded yet/);
});

test("loadSessionReportData only keeps latest effect when session ids match", async () => {
  const data = await loadSessionReportData({
    stateDir: "/tmp/tokenpilot-state",
    sessionId: "sess-a",
    detailsEnabled: true,
    readers: {
      async readLatest() {
        return { sessionId: "sess-b", countMode: "chars" };
      },
      async readAggregate() {
        return {
          turns: 2,
          latestCountMode: "chars",
          tokenOptimizedTurns: 0,
          tokenSavedCount: 0,
          avgSavedTokensPerOptimizedTurn: 0,
          charOptimizedTurns: 1,
          charSavedCount: 120,
          avgSavedCharsPerOptimizedTurn: 120,
        };
      },
      async readRecentMetrics() {
        return null;
      },
    },
  });

  assert.equal(data.latest, null);
  assert.equal(data.aggregate?.charSavedCount, 120);
});

test("renderSessionReport skips recent metrics reads when details are disabled", async () => {
  let metricsReadCount = 0;
  const text = await renderSessionReport({
    stateDir: "/tmp/tokenpilot-state",
    title: "TokenPilot report:",
    sessionId: "sess-lite",
    detailsEnabled: false,
    readers: {
      async readLatest() {
        return { sessionId: "sess-lite", countMode: "chars" };
      },
      async readAggregate() {
        return {
          turns: 1,
          latestCountMode: "chars",
          tokenOptimizedTurns: 0,
          tokenSavedCount: 0,
          avgSavedTokensPerOptimizedTurn: 0,
          charOptimizedTurns: 1,
          charSavedCount: 64,
          avgSavedCharsPerOptimizedTurn: 64,
        };
      },
      async readRecentMetrics() {
        metricsReadCount += 1;
        return {
          sampledTurns: 1,
          routeSavedChars: { code_like: 64 },
          routeHitCount: { code_like: 1 },
          passSavedChars: { tool_payload_trim: 64 },
          recoveryObservedSegments: 0,
          recoverySkippedSegments: 0,
          skippedReasons: {},
        };
      },
    },
  });

  assert.equal(metricsReadCount, 0);
  assert.match(text, /saved chars: 64/);
  assert.doesNotMatch(text, /recent sampled turns/);
});
