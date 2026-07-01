import assert from "node:assert/strict";
import test from "node:test";

import { formatSessionReport } from "../src/presentation.js";
import { renderVisualPageHtml } from "../src/visual/session-visual-page.js";

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
  });

  assert.match(text, /saved chars: 162,795/);
  assert.match(text, /optimized turns: 2/);
  assert.match(text, /avg saved chars per optimized turn: 81,398/);
  assert.match(text, /latest request savings: 80,000 chars/);
  assert.match(text, /latest response savings: 1,397 chars/);
});

test("formatSessionReport falls back to token aggregates when latest mode is unset", () => {
  const text = formatSessionReport({
    sessionId: "session-token-1",
    aggregate: {
      turns: 5,
      latestCountMode: "litellm_tokens",
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
});
