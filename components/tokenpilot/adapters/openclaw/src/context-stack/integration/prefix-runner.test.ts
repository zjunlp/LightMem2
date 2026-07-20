import test from "node:test";
import assert from "node:assert/strict";

import { createOpenClawPayloadCodec, createOpenClawSessionResolver } from "./openclaw-host-adapter.js";
import { runPrefixIfEnabled } from "./prefix-runner.js";

function createCodec() {
  const deps = {
    resolveSessionIdForPayload: () => "session-prefix-runner",
    extractInputText: () => "",
  };
  return createOpenClawPayloadCodec(deps, createOpenClawSessionResolver(deps));
}

test("prefix runner preserves inbound fields when disabled", () => {
  const payload: any = {
    model: "gpt-5.4-mini",
    prompt_cache_key: "inbound-key",
    input: [{ role: "developer", content: "original" }],
  };
  const codec = createCodec();
  const result = runPrefixIfEnabled({
    enabled: false,
    payload,
    requestEnvelope: codec.decodeRequest(payload),
    payloadCodec: codec,
    model: payload.model,
    dynamicContextTarget: "developer",
    helpers: {
      findDeveloperAndPrimaryUser: () => {
        throw new Error("disabled prefix must not inspect prompt roles");
      },
    },
  });

  assert.equal(result.enabled, false);
  assert.equal(result.originalPromptCacheKey, "inbound-key");
  assert.equal(result.stableRewrite.promptCacheKey, "inbound-key");
  assert.deepEqual(payload.input, [{ role: "developer", content: "original" }]);
});
