import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMAL_HOST_CAPABILITIES,
  REQUEST_RESPONSE_HOST_CAPABILITIES,
  canSupportLifecycleEvictionEquivalently,
  canSupportReductionCore,
  canSupportStablePrefix,
  canSupportToolCallMemo,
} from "../src/contracts/capabilities.js";

test("minimal host capabilities disable advanced runtime assumptions by default", () => {
  assert.equal(canSupportStablePrefix(MINIMAL_HOST_CAPABILITIES), false);
  assert.equal(canSupportReductionCore(MINIMAL_HOST_CAPABILITIES), false);
  assert.equal(canSupportLifecycleEvictionEquivalently(MINIMAL_HOST_CAPABILITIES), false);
  assert.equal(canSupportToolCallMemo(MINIMAL_HOST_CAPABILITIES), false);
});

test("request-response capability preset supports stable prefix and reduction core only", () => {
  assert.equal(canSupportStablePrefix(REQUEST_RESPONSE_HOST_CAPABILITIES), true);
  assert.equal(canSupportReductionCore(REQUEST_RESPONSE_HOST_CAPABILITIES), true);
  assert.equal(canSupportLifecycleEvictionEquivalently(REQUEST_RESPONSE_HOST_CAPABILITIES), false);
  assert.equal(canSupportToolCallMemo(REQUEST_RESPONSE_HOST_CAPABILITIES), false);
});
