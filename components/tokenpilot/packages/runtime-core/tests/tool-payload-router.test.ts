import test from "node:test";
import assert from "node:assert/strict";

import { classifyToolPayloadContent, classifyToolPayloadContentWithHint } from "../src/reduction/content-classifier.js";
import { reduceToolPayloadText } from "../src/reduction/tool-payload-router.js";

const defaultCfg = {
  stdout: {
    enabled: true,
    maxChars: 200,
    keepHeadLines: 3,
    keepTailLines: 2,
    maxPreviewChars: 80,
    maxItems: 4,
    maxDepth: 2,
  },
  stderr: {
    enabled: true,
    maxChars: 200,
    keepHeadLines: 3,
    keepTailLines: 2,
    maxPreviewChars: 80,
    maxItems: 4,
    maxDepth: 2,
  },
  json: {
    enabled: true,
    maxChars: 200,
    keepHeadLines: 3,
    keepTailLines: 2,
    maxPreviewChars: 80,
    maxItems: 3,
    maxDepth: 2,
  },
  blob: {
    enabled: true,
    maxChars: 80,
    keepHeadLines: 1,
    keepTailLines: 1,
    maxPreviewChars: 32,
    maxItems: 2,
    maxDepth: 1,
  },
};

test("classifyToolPayloadContent detects json arrays", () => {
  const result = classifyToolPayloadContent(JSON.stringify([
    { type: "result", value: "alpha" },
    { type: "warning", value: "beta" },
  ]));
  assert.equal(result.contentType, "json_array");
});

test("classifyToolPayloadContent detects search results", () => {
  const result = classifyToolPayloadContent([
    "src/a.ts:10:const bad = true",
    "src/a.ts:22:throw new Error('x')",
    "src/b.ts:8:TODO fix warning",
  ].join("\n"));
  assert.equal(result.contentType, "search_results");
});

test("classifyToolPayloadContentWithHint uses tool hints to classify code reads", () => {
  const result = classifyToolPayloadContentWithHint(`
function runTask() {
  return true;
}
class Worker {}
`, {
    toolName: "read",
    payloadKind: "stdout",
    fieldName: "output",
  });
  assert.equal(result.contentType, "code_like");
});

test("classifyToolPayloadContentWithHint uses read path extension as code hint", () => {
  const result = classifyToolPayloadContentWithHint("just some content", {
    toolName: "read",
    path: "/repo/src/app/main.ts",
    payloadKind: "stdout",
  });
  assert.equal(result.contentType, "code_like");
});

test("reduceToolPayloadText summarizes large json arrays with omission summary", () => {
  const payload = JSON.stringify([
    { type: "result", id: 1, text: "alpha".repeat(20) },
    { type: "result", id: 2, text: "beta".repeat(20) },
    { type: "warning", id: 3, text: "gamma".repeat(20) },
    { type: "warning", id: 4, text: "delta".repeat(20) },
    { type: "error", id: 5, text: "epsilon".repeat(20) },
  ], null, 2);

  const result = reduceToolPayloadText(payload, "json", defaultCfg);
  assert.equal(result.route, "json_array");
  assert.equal(result.changed, true);
  assert.match(result.text, /"omittedSummary"/);
  assert.match(result.text, /warning|error|result/);
  assert.match(result.text, /"keptIndices"/);
});

test("reduceToolPayloadText keeps anomalous json items via anchor selection", () => {
  const items = Array.from({ length: 12 }, (_value, index) => ({
    type: "result",
    status: "ok",
    id: index,
    text: `item-${index}`,
  }));
  items[9] = {
    type: "result",
    status: "error",
    id: 9,
    rare_field: "anomaly",
    text: "important failure marker".repeat(8),
  };

  const payload = JSON.stringify(items, null, 2);
  const result = reduceToolPayloadText(payload, "json", defaultCfg);
  assert.equal(result.route, "json_array");
  assert.equal(result.changed, true);
  assert.match(result.text, /important failure marker|anomaly|error/);
});

test("reduceToolPayloadText specializes web-style json payloads", () => {
  const payload = JSON.stringify({
    answer: "The repository contains papers on LLM agents and planning.",
    results: [
      {
        title: "zjunlp/LLMAgentPapers",
        url: "https://github.com/zjunlp/LLMAgentPapers",
        content: "Plan-and-solve prompting and multi-agent collaboration are included.".repeat(8),
        score: 0.88,
      },
      {
        title: "GitHub topics",
        url: "https://github.com/topics/paper-list",
        content: "A list of paper collections.".repeat(10),
        score: 0.77,
      },
    ],
    result_count: 2,
    response_time: 3.49,
  }, null, 2);

  const result = reduceToolPayloadText(payload, "json", defaultCfg, {
    toolName: "web_fetch",
    payloadKind: "json",
    fieldName: "output",
  });
  assert.equal(result.route, "json_object");
  assert.equal(result.changed, true);
  assert.match(result.text, /"reduced": "web_result_json"/);
  assert.match(result.text, /"answerPreview"/);
  assert.match(result.text, /"resultIndices"/);
  assert.match(result.text, /"resultsPreview"/);
});

test("reduceToolPayloadText groups search results by file", () => {
  const payload = [
    "src/auth.ts:10:const token = readToken()",
    "src/auth.ts:15:throw new Error('invalid token')",
    "src/ui.ts:3:render(app)",
    "src/ui.ts:18:// TODO warn user",
    "src/db.ts:9:connection failed due to timeout",
    "src/db.ts:14:retry connection",
  ].join("\n");

  const result = reduceToolPayloadText(payload.repeat(4), "stdout", defaultCfg);
  assert.equal(result.route, "search_results");
  assert.equal(result.changed, true);
  assert.match(result.text, /src\/auth\.ts \(\d+ matches\)/);
  assert.match(result.text, /\[search results reduced\]/);
});

test("reduceToolPayloadText keeps important log lines", () => {
  const payload = [
    "npm test",
    "running suite",
    "WARN deprecated package detected",
    "Error: build failed",
    "    at compile (/app/build.js:10:1)",
    "    at main (/app/main.js:2:1)",
    "done",
  ].join("\n").repeat(6);

  const result = reduceToolPayloadText(payload, "stderr", defaultCfg);
  assert.equal(result.route, "log_output");
  assert.equal(result.changed, true);
  assert.match(result.text, /log reduced important_lines=/);
  assert.match(result.text, /Error: build failed/);
});

test("reduceToolPayloadText summarizes diff payloads by file", () => {
  const payload = `
diff --git a/src/app.ts b/src/app.ts
index 123..456 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
-const a = 1;
+const a = 2;
+const b = 3;
 export function run() {}
diff --git a/src/lib.ts b/src/lib.ts
index 111..222 100644
--- a/src/lib.ts
+++ b/src/lib.ts
@@ -3,3 +3,4 @@
-return oldValue;
+return newValue;
+console.log(newValue);
 `.repeat(4);

  const result = reduceToolPayloadText(payload, "stdout", defaultCfg, {
    toolName: "git_diff",
    payloadKind: "stdout",
  });
  assert.equal(result.route, "diff_output");
  assert.equal(result.changed, true);
  assert.match(result.text, /\[diff reduced files=/);
  assert.match(result.text, /src\/app\.ts/);
  assert.match(result.text, /\+\d+ -\d+/);
});

test("reduceToolPayloadText summarizes code-like payloads by signatures", () => {
  const payload = `
import fs from "node:fs";

export class SearchService {
  constructor(private root: string) {}
}

export async function runSearch(query: string) {
  return query;
}

function helperTransform(input: string) {
  return input.trim();
}

const buildIndex = (
  files: string[],
) => {
  return files.map((file) => file.toLowerCase());
};
`.repeat(8);

  const result = reduceToolPayloadText(payload, "stdout", defaultCfg);
  assert.equal(result.route, "code_like");
  assert.equal(result.changed, true);
  assert.match(result.text, /\[code outlined lines=/);
  assert.match(result.text, /imports:/);
  assert.match(result.text, /\[outlined definitions;/);
  assert.match(result.text, /body elided by LightMem2/);
  assert.match(result.text, /export class SearchService/);
  assert.match(result.text, /export async function runSearch/);
});

test("reduceToolPayloadText outlines exported declarations in file order", () => {
  const payload = `
import fs from "node:fs";

export function loadSessionIndex(sessionId: string) {
  return fs.readFileSync(sessionId, "utf8");
}

export function renderTerminalFrame(text: string) {
  return text.toUpperCase();
}

export class SessionCache {
  hydrate(id: string) {
    return loadSessionIndex(id);
  }
}
`.repeat(8);

  const result = reduceToolPayloadText(payload, "stdout", defaultCfg, {
    toolName: "read",
    path: "/repo/src/session.ts",
    payloadKind: "stdout",
  });

  assert.equal(result.route, "code_like");
  assert.equal(result.changed, true);
  assert.match(result.text, /export function loadSessionIndex/);
  assert.match(result.text, /export function renderTerminalFrame/);
  assert.match(result.text, /export class SessionCache/);
});

test("reduceToolPayloadText keeps controlled small-window code reads intact", () => {
  const payload = [
    "  1 | import fs from \"node:fs\";",
    "  2 | import path from \"node:path\";",
    "  3 | ",
    "  4 | export function loadConfig(file: string) {",
    "  5 |   const full = path.resolve(file);",
    "  6 |   return fs.readFileSync(full, \"utf8\");",
    "  7 | }",
    "  8 | ",
    "  9 | export function saveConfig(file: string, text: string) {",
    " 10 |   fs.writeFileSync(path.resolve(file), text, \"utf8\");",
    " 11 | }",
  ].join("\n").repeat(4);

  const result = reduceToolPayloadText(payload, "stdout", defaultCfg, {
    toolName: "bash",
    path: "/repo/src/config.ts",
    payloadKind: "stdout",
  });
  assert.equal(result.route, "code_like");
  assert.equal(result.changed, false);
});

test("reduceToolPayloadText does not outline explicit code line windows", () => {
  const payload = [
    "120 | export function loadConfig(file: string) {",
    "121 |   const full = path.resolve(file);",
    "122 |   return fs.readFileSync(full, \"utf8\");",
    "123 | }",
  ].join("\n").repeat(4);

  const result = reduceToolPayloadText(payload, "stdout", defaultCfg, {
    toolName: "read",
    path: "/repo/src/config.ts?start_line=120&end_line=123",
    payloadKind: "stdout",
  });

  assert.equal(result.route, "code_like");
  assert.equal(result.changed, false);
});

test("reduceToolPayloadText passes through repeated reads of the same code path", () => {
  const payload = `
export function loadConfig(file: string) {
  return file.trim();
}

export function saveConfig(file: string, text: string) {
  return text + file;
}
`.repeat(20);

  const result = reduceToolPayloadText(payload, "stdout", defaultCfg, {
    toolName: "read",
    path: "/repo/src/config.ts",
    payloadKind: "stdout",
  }, {
    previouslyReadPaths: new Set(["/repo/src/config.ts"]),
  });

  assert.equal(result.route, "code_like");
  assert.equal(result.changed, false);
  assert.match(result.reason, /progressive_disclosure_repeat_read/);
});

test("reduceToolPayloadText compresses stale read payloads more aggressively", () => {
  const payload = JSON.stringify(
    Array.from({ length: 10 }, (_value, index) => ({
      type: index === 7 ? "error" : "result",
      id: index,
      text: `entry-${index}-${"x".repeat(80)}`,
    })),
    null,
    2,
  );

  const fresh = reduceToolPayloadText(payload, "json", defaultCfg, {
    toolName: "read",
    payloadKind: "json",
    readState: "fresh",
  });
  const stale = reduceToolPayloadText(payload, "json", defaultCfg, {
    toolName: "read",
    payloadKind: "json",
    readState: "stale",
  });

  assert.equal(fresh.changed, true);
  assert.equal(stale.changed, true);
  assert.ok(stale.text.length < fresh.text.length);
});

test("reduceToolPayloadText compresses superseded read payloads more than fresh reads", () => {
  const payload = [
    "src/auth.ts:10:const token = readToken()",
    "src/auth.ts:15:throw new Error('invalid token')",
    "src/ui.ts:3:render(app)",
    "src/ui.ts:18:// TODO warn user",
    "src/db.ts:9:connection failed due to timeout",
    "src/db.ts:14:retry connection",
  ].join("\n").repeat(5);

  const fresh = reduceToolPayloadText(payload, "stdout", defaultCfg, {
    toolName: "read",
    payloadKind: "stdout",
    path: "/repo/log.txt",
    readState: "fresh",
  });
  const superseded = reduceToolPayloadText(payload, "stdout", defaultCfg, {
    toolName: "read",
    payloadKind: "stdout",
    path: "/repo/log.txt",
    readState: "superseded",
  });

  assert.equal(fresh.changed, true);
  assert.equal(superseded.changed, true);
  assert.ok(superseded.text.length < fresh.text.length);
});

test("reduceToolPayloadText keeps stale code reads less compressed than stale logs", () => {
  const codePayload = [
    "import fs from \"node:fs\";",
    "export function load(path: string) {",
    "  const text = fs.readFileSync(path, \"utf8\");",
    "  if (!text) return \"\";",
    "  return text.trim();",
    "}",
  ].join("\n").repeat(40);
  const logPayload = [
    "WARN deprecated package detected",
    "Error: build failed",
    "    at compile (/app/build.js:10:1)",
    "    at main (/app/main.js:2:1)",
    "done",
  ].join("\n").repeat(18);

  const staleCode = reduceToolPayloadText(codePayload, "stdout", defaultCfg, {
    toolName: "bash",
    path: "/repo/src/config.ts",
    payloadKind: "stdout",
    readState: "stale",
  });
  const staleLog = reduceToolPayloadText(logPayload, "stderr", defaultCfg, {
    toolName: "read",
    path: "/repo/build.log",
    payloadKind: "stderr",
    readState: "stale",
  });

  assert.equal(staleCode.route, "code_like");
  assert.equal(staleLog.route, "log_output");
  assert.equal(staleCode.changed, true);
  assert.equal(staleLog.changed, true);
  assert.ok(staleCode.text.length > staleLog.text.length);
});
