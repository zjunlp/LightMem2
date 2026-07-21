import assert from "node:assert/strict";
import test from "node:test";
import { formatCliUsage } from "../src/usage.js";

test("usage mentions top-level and host-scoped commands", () => {
  const text = formatCliUsage();
  assert.match(text, /lightmem2 <command>/);
  assert.match(text, /lightmem2 <host> <command>/);
  assert.match(text, /use <host>/);
  assert.match(text, /openclaw/);
  assert.match(text, /codex/);
});
