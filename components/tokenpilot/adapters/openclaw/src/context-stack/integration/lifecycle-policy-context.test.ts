import test from "node:test";
import assert from "node:assert/strict";

import { buildLifecyclePolicyContext } from "./lifecycle-policy-context.js";

test("lifecycle policy context does not construct reduction segments", () => {
  const context = buildLifecyclePolicyContext({
    sessionId: " session-1 ",
    model: "gpt-5.4-mini",
    prompt: "developer\nuser\ntool output",
  });

  assert.equal(context.sessionId, "session-1");
  assert.equal(context.model, "gpt-5.4-mini");
  assert.equal(context.prompt, "developer\nuser\ntool output");
  assert.deepEqual(context.segments, []);
  assert.deepEqual(context.metadata?.policyContext, {
    source: "lifecycle",
    reductionContextBuilt: false,
  });
});
