import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateJsonInformationScore,
  inferJsonAnchorPattern,
  selectJsonArrayAnchorIndices,
} from "../src/reduction/json-anchor-selector.js";

test("calculateJsonInformationScore gives higher score to anomalous records", () => {
  const items = [
    { type: "result", status: "ok", value: "a" },
    { type: "result", status: "ok", value: "b" },
    { type: "result", status: "ok", value: "c" },
    { type: "result", status: "error", rare_field: "x", value: "d".repeat(40) },
  ];

  const normalScore = calculateJsonInformationScore(items[0], items);
  const anomalyScore = calculateJsonInformationScore(items[3], items);
  assert.ok(anomalyScore > normalScore);
});

test("selectJsonArrayAnchorIndices keeps front/back and anomalous middle items", () => {
  const items: Array<Record<string, unknown>> = Array.from({ length: 14 }, (_value, index) => ({
    type: "result",
    status: "ok",
    id: index,
    value: `item-${index}`,
  }));

  items[8] = {
    type: "result",
    status: "error",
    id: 8,
    rare_field: "anomaly",
    value: "very important marker".repeat(12),
  };

  const indices = selectJsonArrayAnchorIndices(items, {
    maxItems: 6,
    pattern: "generic",
    dedupIdenticalItems: true,
    useInformationDensity: true,
  });

  assert.ok(indices.some((index) => index <= 2));
  assert.ok(indices.some((index) => index >= 12));
  assert.ok(indices.includes(8));
  assert.ok(indices.length <= 6);
});

test("selectJsonArrayAnchorIndices deduplicates identical object items", () => {
  const repeated = { type: "result", status: "ok", value: "same" };
  const items = [
    repeated,
    repeated,
    repeated,
    { type: "result", status: "warn", value: "different-1" },
    { type: "result", status: "error", value: "different-2" },
    { type: "result", status: "ok", value: "different-3" },
  ];

  const indices = selectJsonArrayAnchorIndices(items, {
    maxItems: 4,
    pattern: "generic",
    dedupIdenticalItems: true,
    useInformationDensity: true,
  });

  const selectedRepeated = indices.filter((index) => index <= 2);
  assert.ok(selectedRepeated.length <= 1);
});

test("inferJsonAnchorPattern detects search-style result arrays", () => {
  const pattern = inferJsonAnchorPattern([
    { title: "A", url: "https://a", content: "text", score: 0.9 },
    { title: "B", url: "https://b", content: "text", score: 0.8 },
    { title: "C", url: "https://c", content: "text", score: 0.7 },
  ]);
  assert.equal(pattern, "search_results");
});

test("selectJsonArrayAnchorIndices adjusts toward back for recency queries", () => {
  const items = Array.from({ length: 12 }, (_value, index) => ({
    timestamp: `2026-06-${String(index + 1).padStart(2, "0")}`,
    value: index,
  }));

  const recencyIndices = selectJsonArrayAnchorIndices(items, {
    maxItems: 4,
    pattern: "time_series",
    queryText: "show me the latest recent values",
  });
  const historicalIndices = selectJsonArrayAnchorIndices(items, {
    maxItems: 4,
    pattern: "time_series",
    queryText: "show me the first original values",
  });

  const recencyBackCount = recencyIndices.filter((index) => index >= 8).length;
  const historicalFrontCount = historicalIndices.filter((index) => index <= 3).length;
  assert.ok(recencyBackCount >= 2);
  assert.ok(historicalFrontCount >= 2);
});
