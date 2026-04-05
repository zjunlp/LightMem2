import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRootPromptRewriteToChatMessages,
  rewriteRootPromptForStablePrefix,
} from "./root-prompt-stabilizer.js";

test("rewriteRootPromptForStablePrefix canonicalizes workdir and agent identifiers", () => {
  const raw = [
    "Runtime: agent=bench-dica-gpt-5-4-mini-0123-j0002 | host=mistral",
    "Your working directory is: /tmp/pinchbench/0123/agent_workspace_j0002",
    "## /tmp/pinchbench/0123/agent_workspace_j0002/AGENTS.md",
    "[MISSING] Expected at: /tmp/pinchbench/0123/agent_workspace_j0002/BOOTSTRAP.md",
  ].join("\n");

  const rewritten = rewriteRootPromptForStablePrefix(raw);

  assert.equal(rewritten.changed, true);
  assert.match(rewritten.forwardedPromptText, /Runtime: agent=<AGENT_ID>\| host=mistral/);
  assert.match(rewritten.forwardedPromptText, /Your working directory is: <WORKDIR>/);
  assert.match(rewritten.forwardedPromptText, /^## AGENTS\.md$/m);
  assert.match(rewritten.forwardedPromptText, /\[MISSING\] Expected at: BOOTSTRAP\.md/);
  assert.equal(
    rewritten.dynamicContextText,
    "- WORKDIR: /tmp/pinchbench/0123/agent_workspace_j0002\n- AGENT_ID: bench-dica-gpt-5-4-mini-0123-j0002",
  );
});

test("applyRootPromptRewriteToChatMessages rewrites system prompt and prepends dynamic context to first user", () => {
  const messages = [
    {
      role: "system",
      content: [
        {
          type: "text",
          text: [
            "Runtime: agent=bench-dica-gpt-5-4-mini-0123-j0002 | host=mistral",
            "Your working directory is: /tmp/pinchbench/0123/agent_workspace_j0002",
            "## /tmp/pinchbench/0123/agent_workspace_j0002/AGENTS.md",
          ].join("\n"),
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Analyze the spreadsheet and write a summary." }],
    },
  ];

  const rewritten = applyRootPromptRewriteToChatMessages(messages);

  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.systemIndex, 0);
  assert.equal(rewritten.userIndex, 1);
  assert.match(rewritten.messages[0].content[0].text, /Your working directory is: <WORKDIR>/);
  assert.match(rewritten.messages[0].content[0].text, /^## AGENTS\.md$/m);
  assert.match(
    rewritten.messages[1].content[0].text,
    /- WORKDIR: \/tmp\/pinchbench\/0123\/agent_workspace_j0002\n- AGENT_ID: bench-dica-gpt-5-4-mini-0123-j0002\n\nAnalyze the spreadsheet and write a summary\./,
  );
});
