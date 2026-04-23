import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ECOCLAW_EVENT_TYPES, findRuntimeEventsByType } from "@ecoclaw/kernel";
import { createReductionModule } from "../src/composer/reduction/index.js";
import { createMockRuntime, createTurnContext, createTurnResult } from "./test-utils.js";

test("reduction trims tool payloads before call and slims formatting after call", async () => {
  const module = createReductionModule({
    maxToolChars: 400,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const toolBody = Array.from({ length: 40 }, (_, index) => `line-${index} some verbose output`).join("\n");
  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-1",
        kind: "volatile",
        text: `stdout:\n${toolBody}`,
        priority: 4,
        source: "tool",
        metadata: { role: "tool" },
      },
    ],
    metadata: {
      policy: {
        version: "v2",
        mode: "online",
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: ["tool_payload_trim"],
            afterCallPassIds: ["format_slimming"],
            instructions: [
              {
                strategy: "tool_payload_trim",
                segmentIds: ["tool-1"],
                confidence: 0.8,
                priority: 8,
                rationale: "Found 1 stdout payload(s) totaling 1631 chars",
                parameters: { payloadKind: "stdout", segmentCount: 1, totalChars: 1631 },
              },
              {
                strategy: "format_slimming",
                segmentIds: ["result-content"],
                confidence: 0.95,
                priority: 5,
                rationale: "markdown content can be slimmed",
                parameters: { formatType: "markdown" },
              },
            ],
          },
        },
      },
    },
  });

  const before = await module.beforeCall!(ctx, runtime);
  assert.ok(before.segments[0]!.text.includes("reduced lines="));
  assert.equal(
    findRuntimeEventsByType(before.metadata, ECOCLAW_EVENT_TYPES.REDUCTION_BEFORE_CALL_RECORDED).length,
    1,
  );

  const result = createTurnResult({
    content: "```ts\nconst x = 1;\n```\n\n\nnext line  ",
  });
  const after = await module.afterCall!(before, result, runtime);
  assert.equal(after.content.includes("```"), false);
  assert.equal(after.content.includes("\n\n\n"), false);
  const reductionMeta = after.metadata?.reduction as Record<string, unknown>;
  assert.ok(reductionMeta.afterCallSummary);
  assert.equal(
    findRuntimeEventsByType(after.metadata, ECOCLAW_EVENT_TYPES.REDUCTION_AFTER_CALL_RECORDED).length,
    1,
  );
});

test("html payloads keep only whitelisted attributes", async () => {
  const module = createReductionModule({
    maxToolChars: 400,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-html",
        kind: "volatile",
        text: '<div class="hero" href="/" onclick="alert(1)" aria-label="Welcome" data-extra="secret"><p>hello</p></div>',
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          isToolPayload: true,
          toolPayload: { enabled: true, toolName: "browser" },
          reduction: {
            target: "tool_payload",
            toolPayloadTrim: { enabled: true },
          },
        },
      },
    ],
    metadata: {
      policy: {
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: ["tool_payload_trim"],
            afterCallPassIds: [],
            instructions: [
              {
                strategy: "tool_payload_trim",
                segmentIds: ["tool-html"],
                confidence: 0.8,
                priority: 8,
                rationale: "Found 1 html payload(s)",
                parameters: { payloadKind: "html", segmentCount: 1 },
              },
            ],
          },
        },
      },
    },
  });

  const before = await module.beforeCall!(ctx, runtime);
  const text = before.segments[0]!.text;
  assert.ok(/onclick/.test(text) === false);
  assert.ok(/data-extra/.test(text) === false);
  assert.match(text, /aria-label="Welcome"/);
  assert.match(text, /href="\/"/);
  assert.match(text, /<p>hello<\/p>/);
});

test("reduction does not trim large markdown read payloads without explicit payload kind", async () => {
  const module = createReductionModule({
    maxToolChars: 320,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const readBody = [
    "# INCIDENT REPORT",
    "From: infra@example.com",
    "To: team@example.com",
    "Subject: Overnight outage summary",
    "",
    ...Array.from({ length: 36 }, (_, index) => `detail line ${index} with repeated operational context`),
    "",
    "## Next steps",
    "confirm rollback",
    "publish postmortem",
  ].join("\n");

  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-read-1",
        kind: "volatile",
        text: readBody,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          isToolPayload: true,
          toolPayload: { enabled: true, toolName: "read" },
          reduction: {
            target: "tool_payload",
            toolPayloadTrim: { enabled: true },
          },
        },
      },
    ],
    // No policy instructions for this segment
  });

  const before = await module.beforeCall!(ctx, runtime);
  const reduced = before.segments[0]!.text;
  assert.equal(reduced, readBody, "Should not reduce without policy instructions");
});

test("reduction does not trim plain-text reads with markdown code fences", async () => {
  const module = createReductionModule({
    maxToolChars: 320,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const readBody = [
    "# AGENTS.md",
    "",
    "## Memory",
    "",
    "```json",
    "{",
    '  "lastChecks": {',
    '    "email": 1703275200',
    "  }",
    "}",
    "```",
    "",
    ...Array.from({ length: 40 }, (_, index) => `plain line ${index} with long explanatory content`),
    "",
    "[13 more lines in file. Use offset=201 to continue.]",
  ].join("\n");

  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-read-codefence",
        kind: "volatile",
        text: readBody,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          isToolPayload: true,
          toolPayload: { enabled: true, toolName: "read" },
          reduction: {
            target: "tool_payload",
            toolPayloadTrim: { enabled: true },
          },
        },
      },
    ],
    // No policy instructions
  });

  const before = await module.beforeCall!(ctx, runtime);
  const reduced = before.segments[0]!.text;
  assert.equal(reduced, readBody, "Should not reduce without policy instructions");
});

test("reduction does not trim large plain-text email-like payloads without explicit payload kind", async () => {
  const module = createReductionModule({
    maxToolChars: 320,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const emailBody = [
    "From: alerts@example.com",
    "To: ops@example.com",
    "Subject: Build pipeline regression",
    "Date: Fri, 04 Apr 2026 09:15:00 +0800",
    "",
    ...Array.from({ length: 48 }, (_, index) => `body line ${index} with concrete diagnostic details`),
    "",
    "Regards,",
    "CI monitor",
  ].join("\n");

  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-email-1",
        kind: "volatile",
        text: emailBody,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          isToolPayload: true,
          toolPayload: { enabled: true, toolName: "gmail_search" },
          reduction: {
            target: "tool_payload",
            toolPayloadTrim: { enabled: true },
          },
        },
      },
    ],
    // No policy instructions
  });

  const before = await module.beforeCall!(ctx, runtime);
  assert.equal(before.segments[0]!.text, emailBody, "Should not reduce without policy instructions");
});

test("reduction skips tool_payload_trim when no policy instructions provided", async () => {
  const module = createReductionModule({
    maxToolChars: 100,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-1",
        kind: "volatile",
        text: "some output",
        priority: 4,
        source: "tool",
        metadata: { role: "tool" },
      },
    ],
    metadata: {
      policy: {
        version: "v2",
        mode: "online",
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: ["tool_payload_trim"],
            afterCallPassIds: [],
            instructions: [], // Empty instructions
          },
        },
      },
    },
  });

  const before = await module.beforeCall!(ctx, runtime);
  // Should skip because no instructions
  const reductionMeta = before.metadata?.reduction as Record<string, unknown>;
  const beforeCallSummary = reductionMeta?.beforeCallSummary as Record<string, unknown>;
  const passBreakdown = (beforeCallSummary?.passBreakdown as Array<Record<string, unknown>>) ?? [];
  const toolPayloadPass = passBreakdown.find((p) => p.id === "tool_payload_trim");
  assert.ok(toolPayloadPass);
  assert.equal(toolPayloadPass.skippedReason, "no_policy_instructions");
});

test("reduction skips tool payload trim when recovery placeholder would not save chars", async () => {
  const module = createReductionModule({
    maxToolChars: 40,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const smallStdout = [
    "row-01 short",
    "row-02 short",
    "row-03 short",
    "row-04 short",
    "row-05 short",
    "row-06 short",
  ].join("\n");
  const ctx = createTurnContext({
    sessionId: "bench-0001-j0001",
    segments: [
      {
        id: "tool-json-small",
        kind: "volatile",
        text: smallStdout,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "exec",
            path: "/tmp/pinchbench/0001/agent_workspace_j0001/out.json",
          },
        },
      },
    ],
    metadata: {
      workspaceDir: "/tmp/pinchbench/0001/agent_workspace_j0001",
      policy: {
        version: "v2",
        mode: "online",
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: ["tool_payload_trim"],
            afterCallPassIds: [],
            instructions: [
              {
                strategy: "tool_payload_trim",
                segmentIds: ["tool-json-small"],
                parameters: { payloadKind: "stdout" },
              },
            ],
          },
        },
      },
    },
  });

  const before = await module.beforeCall!(ctx, runtime);
  assert.equal(before.segments[0]!.text, smallStdout);
  const reductionMeta = before.metadata?.reduction as Record<string, unknown>;
  const beforeCallSummary = reductionMeta?.beforeCallSummary as Record<string, unknown>;
  const passBreakdown = (beforeCallSummary?.passBreakdown as Array<Record<string, unknown>>) ?? [];
  const toolPayloadPass = passBreakdown.find((p) => p.id === "tool_payload_trim");
  assert.ok(toolPayloadPass);
  assert.equal(toolPayloadPass.skippedReason, "no_net_savings");
});

test("reduction trims large stdout payload from real transcript: memory task", async () => {
  // From task_08_memory-transcript.txt: read returns a ~1000 byte project notes document
  // This is a real pattern: large tool payload that can be trimmed
  const module = createReductionModule({
    maxToolChars: 400,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const readBody = [
    "# Project Phoenix - Development Notes",
    "",
    "## Timeline",
    "",
    "- **Alpha Release**: March 15, 2024",
    "- **Beta Release**: June 1, 2024",
    "- **Production Launch**: September 30, 2024",
    "",
    "## Team",
    "",
    "- Lead Developer: Sarah Chen",
    "- Backend: Marcus Rodriguez, Aisha Patel",
    "- Frontend: James Kim, Elena Volkov",
    "- QA: David Thompson",
    "",
    "## Key Features",
    "",
    "1. Real-time collaboration",
    "2. Advanced analytics dashboard",
    "3. Mobile app integration",
    "4. API v2 with GraphQL support",
    "",
    "## Current Status",
    "",
    "We're currently in the alpha testing phase with 50 internal users. Feedback has been positive, particularly regarding the new UI. The beta release is scheduled for June 1, 2024, and we're on track to meet this deadline.",
    "",
    "## Technical Stack",
    "",
    "- Frontend: React 18, TypeScript",
    "- Backend: Node.js, Express, PostgreSQL",
    "- Infrastructure: AWS (ECS, RDS, S3)",
    "- CI/CD: GitHub Actions",
    "",
    "## Blockers",
    "",
    "- Need to finalize API documentation before beta",
    "- Mobile app needs performance optimization",
    "- Waiting on security audit completion",
  ].join("\n");

  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-read-notes",
        kind: "volatile",
        text: readBody,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          isToolPayload: true,
          toolPayload: { enabled: true, toolName: "read" },
          reduction: {
            target: "tool_payload",
            toolPayloadTrim: { enabled: true },
          },
        },
      },
    ],
    metadata: {
      policy: {
        version: "v2",
        mode: "online",
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: ["tool_payload_trim"],
            afterCallPassIds: [],
            instructions: [
              {
                strategy: "tool_payload_trim",
                segmentIds: ["tool-read-notes"],
                confidence: 0.85,
                priority: 8,
                rationale: "Found 1 stdout payload(s) totaling 867 chars",
                parameters: { payloadKind: "stdout", segmentCount: 1, totalChars: 867 },
              },
            ],
          },
        },
      },
    },
  });

  const before = await module.beforeCall!(ctx, runtime);
  const reduced = before.segments[0]!.text;
  assert.ok(reduced.includes("reduced lines="), "Should trim large payload");
  assert.ok(reduced.length < readBody.length, "Should be shorter than original");
  assert.equal(
    findRuntimeEventsByType(before.metadata, ECOCLAW_EVENT_TYPES.REDUCTION_BEFORE_CALL_RECORDED).length,
    1,
  );
});

test("reduction trims html payload from real transcript: blog task", async () => {
  // From task_03_blog-transcript.txt: write returns a 2983 byte blog post
  // This tests html attribute filtering on real content
  const module = createReductionModule({
    maxToolChars: 400,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();

  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-write-blog",
        kind: "volatile",
        text: "Successfully wrote 2983 bytes to blog_post.md",
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          isToolPayload: true,
          toolPayload: { enabled: true, toolName: "write" },
          reduction: {
            target: "tool_payload",
            toolPayloadTrim: { enabled: true },
          },
        },
      },
    ],
    metadata: {
      policy: {
        version: "v2",
        mode: "online",
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: ["tool_payload_trim"],
            afterCallPassIds: [],
            instructions: [
              {
                strategy: "tool_payload_trim",
                segmentIds: ["tool-write-blog"],
                confidence: 0.8,
                priority: 8,
                rationale: "Found 1 stdout payload(s) totaling 38 bytes",
                parameters: { payloadKind: "stdout", segmentCount: 1, totalChars: 38 },
              },
            ],
          },
        },
      },
    },
  });

  const before = await module.beforeCall!(ctx, runtime);
  const text = before.segments[0]!.text;
  // Success message is already short, should remain short
  assert.ok(text.length <= 50, "Should keep short success messages");
  assert.equal(
    findRuntimeEventsByType(before.metadata, ECOCLAW_EVENT_TYPES.REDUCTION_BEFORE_CALL_RECORDED).length,
    1,
  );
});

test("reduction deduplicates repeated reads from real transcript: calendar task", async () => {
  // From task_01_calendar-transcript.txt: agent reads SOUL.md twice in same turn
  // This tests repeated_read_dedup strategy
  const module = createReductionModule({
    maxToolChars: 400,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const soulContent = `# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and "I'd be happy to help!" — just help. Actions speak louder than filler words.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.`;

  const ctx = createTurnContext({
    segments: [
      {
        id: "read-soul-first",
        kind: "volatile",
        text: soulContent,
        priority: 8,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "read",
            path: "/tmp/pinchbench/0127/agent_workspace_j0002/SOUL.md",
          },
        },
      },
      {
        id: "read-soul-second",
        kind: "volatile",
        text: soulContent,
        priority: 7,
        source: "tool",
        metadata: {
          role: "tool",
          toolPayload: {
            toolName: "read",
            path: "/tmp/pinchbench/0127/agent_workspace_j0002/SOUL.md",
          },
        },
      },
    ],
    metadata: {
      policy: {
        version: "v2",
        mode: "online",
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: ["repeated_read_dedup"],
            afterCallPassIds: [],
            instructions: [
              {
                strategy: "repeated_read_dedup",
                segmentIds: ["read-soul-second"],
                confidence: 0.95,
                priority: 7,
                rationale: 'Same path "SOUL.md" was read 2 times; keeping first read',
                parameters: {
                  dataKey: "/tmp/pinchbench/0127/agent_workspace_j0002/SOUL.md",
                  readCount: 2,
                  firstReadSegmentId: "read-soul-first",
                },
              },
            ],
          },
        },
      },
    },
  });

  const before = await module.beforeCall!(ctx, runtime);

  // First read should be preserved
  const firstReadText = before.segments[0]?.text ?? "";
  assert.equal(firstReadText, soulContent, "First read should be preserved");

  // Second read should be deduplicated (replaced with placeholder)
  const secondReadText = before.segments[1]?.text ?? "";
  assert.match(secondReadText, /\[Repeated read deduplicated\]/);
  assert.ok(secondReadText.includes("First read of"), "Should mention first read");

  const reductionMeta = before.metadata?.reduction as Record<string, unknown>;
  const beforeCallSummary = reductionMeta?.beforeCallSummary as Record<string, unknown>;
  const passBreakdown = (beforeCallSummary?.passBreakdown as Array<Record<string, unknown>>) ?? [];
  const dedupPass = passBreakdown.find((p) => p.id === "repeated_read_dedup");
  assert.ok(dedupPass);
  assert.ok((dedupPass as Record<string, unknown>).changed);
  assert.equal(
    findRuntimeEventsByType(before.metadata, ECOCLAW_EVENT_TYPES.REDUCTION_BEFORE_CALL_RECORDED).length,
    1,
  );
});

test("format_cleaning pass strips empty lines, HTML comments, and normalizes whitespace", async () => {
  const module = createReductionModule({
    maxToolChars: 400,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-content",
        kind: "volatile",
        text: `




<div>
  <!-- This is a comment -->
  Content with   multiple   spaces
</div>

<!-- Another comment -->



`,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
          isToolPayload: true,
          toolPayload: { enabled: true, toolName: "browser" },
        },
      },
    ],
    metadata: {
      policy: {
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: [],
            afterCallPassIds: ["format_cleaning"],
            instructions: [
              {
                strategy: "format_cleaning",
                segmentIds: ["tool-content"],
                confidence: 0.9,
                priority: 4,
                rationale: "Format cleaning needed: empty_lines, html_comments, excess_whitespace",
                parameters: {
                  cleaningKinds: ["empty_lines", "html_comments", "excess_whitespace"],
                  estimatedSavings: 100,
                },
              },
            ],
          },
        },
      },
    },
  });

  const result = createTurnResult({
    content: ctx.segments[0]?.text ?? "",
  });
  const after = await module.afterCall!(ctx, result, runtime);

  // Should strip empty lines
  assert.ok(!after.content.startsWith("\n"));
  assert.ok(!after.content.endsWith("\n"));

  // Should strip HTML comments
  assert.ok(!after.content.includes("<!--"));

  // Should normalize whitespace
  assert.ok(!after.content.includes("   "));

  const reductionMeta = after.metadata?.reduction as Record<string, unknown>;
  const afterCallSummary = reductionMeta?.afterCallSummary as Record<string, unknown>;
  assert.ok(afterCallSummary);
});

test("path_truncation pass truncates long file paths", async () => {
  const module = createReductionModule({
    maxToolChars: 400,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const longPath = "/very/long/path/to/some/deeply/nested/directory/structure/that/exceeds/the/max/length/config.json";
  const ctx = createTurnContext({
    segments: [
      {
        id: "tool-output",
        kind: "volatile",
        text: `Successfully read file: ${longPath}
The file contains important configuration data.
Another reference to ${longPath} in the logs.`,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
        },
      },
    ],
    metadata: {
      policy: {
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: [],
            afterCallPassIds: ["path_truncation"],
            instructions: [
              {
                strategy: "path_truncation",
                segmentIds: ["tool-output"],
                confidence: 0.85,
                priority: 3,
                rationale: `Path truncation needed: "${longPath}" exceeds 80 chars`,
                parameters: {
                  maxPathLength: 80,
                  estimatedSavings: 50,
                },
              },
            ],
          },
        },
      },
    },
  });

  const result = createTurnResult({
    content: ctx.segments[0]?.text ?? "",
  });
  const after = await module.afterCall!(ctx, result, runtime);

  // Long path should be truncated
  assert.ok(!after.content.includes(longPath));
  assert.ok(after.content.includes("..."));
  assert.ok(after.content.includes("config.json"));

  const reductionMeta = after.metadata?.reduction as Record<string, unknown>;
  const pathTruncation = (reductionMeta?.afterCall as Array<Record<string, unknown>>)?.find(
    (e) => e.id === "path_truncation"
  );
  assert.ok(pathTruncation);
  assert.ok(pathTruncation.changed);
});

test("line_number_strip pass removes line number prefixes", async () => {
  const module = createReductionModule({
    maxToolChars: 400,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();
  const contentWithLineNumbers = [
    "   1 | import { test } from 'node:test'",
    "   2 | import assert from 'node:assert'",
    "   3 | ",
    "   4 | test('example', () => {",
    "   5 |   assert.ok(true)",
    "   6 | })",
  ].join("\n");

  const ctx = createTurnContext({
    segments: [
      {
        id: "read-output",
        kind: "volatile",
        text: contentWithLineNumbers,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
        },
      },
    ],
    metadata: {
      policy: {
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: [],
            afterCallPassIds: ["line_number_strip"],
            instructions: [
              {
                strategy: "line_number_strip",
                segmentIds: ["read-output"],
                confidence: 0.9,
                priority: 3,
                rationale: "Line number prefixes detected in 6 lines",
                parameters: {
                  lineCount: 6,
                  estimatedSavings: 60,
                },
              },
            ],
          },
        },
      },
    },
  });

  const result = createTurnResult({
    content: ctx.segments[0]?.text ?? "",
  });
  const after = await module.afterCall!(ctx, result, runtime);

  // Line numbers should be stripped
  assert.ok(!after.content.includes("   1 |"));
  assert.ok(!after.content.includes("   2 |"));
  assert.ok(after.content.includes("import { test }"));
  assert.ok(after.content.includes("assert.ok(true)"));

  const reductionMeta = after.metadata?.reduction as Record<string, unknown>;
  const lineNumberStrip = (reductionMeta?.afterCall as Array<Record<string, unknown>>)?.find(
    (e) => e.id === "line_number_strip"
  );
  assert.ok(lineNumberStrip);
  assert.ok(lineNumberStrip.changed);
});

test("image_downsample pass replaces large base64 images with placeholders", async () => {
  const module = createReductionModule({
    maxToolChars: 400,
    semanticLlmlingua2: { enabled: false },
  });
  const runtime = createMockRuntime();

  // Create a small base64 image (simulated - in reality would be much larger)
  const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const largeBase64Image = `data:image/png;base64,${base64Data.repeat(2000)}`; // Repeat to make it "large"

  const ctx = createTurnContext({
    segments: [
      {
        id: "image-output",
        kind: "volatile",
        text: `Here is the generated image: ${largeBase64Image}

The image shows the chart you requested.`,
        priority: 4,
        source: "tool",
        metadata: {
          role: "tool",
        },
      },
    ],
    metadata: {
      policy: {
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: [],
            afterCallPassIds: ["image_downsample"],
            instructions: [
              {
                strategy: "image_downsample",
                segmentIds: ["image-output"],
                confidence: 0.8,
                priority: 2,
                rationale: "Large PNG image detected, exceeds threshold",
                parameters: {
                  maxImageSizeKB: 100,
                  maxSvgSizeKB: 50,
                  estimatedSavings: 10000,
                },
              },
            ],
          },
        },
      },
    },
  });

  const result = createTurnResult({
    content: ctx.segments[0]?.text ?? "",
  });
  const after = await module.afterCall!(ctx, result, runtime);

  // Large image should be replaced with placeholder
  assert.ok(!after.content.includes("data:image/png;base64,"));
  assert.ok(after.content.includes("[PNG image:"));
  assert.ok(after.content.includes("downsampled"));
  assert.ok(after.content.includes("The image shows the chart"));

  const reductionMeta = after.metadata?.reduction as Record<string, unknown>;
  const imageDownsample = (reductionMeta?.afterCall as Array<Record<string, unknown>>)?.find(
    (e) => e.id === "image_downsample"
  );
  assert.ok(imageDownsample);
  assert.ok(imageDownsample.changed);
});
