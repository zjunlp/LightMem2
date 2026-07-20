import test from "node:test";
import assert from "node:assert/strict";

import { buildRecoveryHint, renderRecoveredArchive } from "../src/index.js";

test("buildRecoveryHint advertises focused line-window recovery", () => {
  const hint = buildRecoveryHint({
    dataKey: "repo:file.ts",
    originalSize: 4096,
    archivePath: "/tmp/archive.json",
    sourceLabel: "tool_payload_trim",
    enabled: true,
  });

  assert.match(hint, /memory_fault_recover/);
  assert.match(hint, /"startLine":20,"endLine":80/);
  assert.match(hint, /internal recovery read; do not call the original tool again/i);
});

test("renderRecoveredArchive returns focused line-window content with recovery metadata", () => {
  const archive = {
    schemaVersion: 1,
    kind: "tool_payload_trim_archive",
    sessionId: "sess-1",
    segmentId: "seg-1",
    sourcePass: "tool_payload_trim",
    toolName: "read",
    dataKey: "repo:file.ts",
    originalText: [
      "1: line one",
      "2: line two",
      "3: line three",
      "4: line four",
      "5: line five",
    ].join("\n"),
    originalSize: 55,
    archivedAt: "2026-07-03T00:00:00.000Z",
  };

  const result = renderRecoveredArchive({
    dataKey: "repo:file.ts",
    archive,
    startLine: 2,
    endLine: 4,
  });

  assert.match(result.text, /^\[Memory Fault Recovery\]/);
  assert.match(result.text, /Recovered lines: 2-4/);
  assert.doesNotMatch(result.text, /1: line one/);
  assert.match(result.text, /2: line two/);
  assert.match(result.text, /4: line four/);
  assert.equal(result.details.recovered, true);
  assert.equal(result.details.recoveredStartLine, 2);
  assert.equal(result.details.recoveredEndLine, 4);
  assert.equal(result.details.recoveredLineCount, 3);
});
