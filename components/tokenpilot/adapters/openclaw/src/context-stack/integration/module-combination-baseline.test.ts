import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testHooks } from "../../plugin-test-support.js";
import {
  MODULE_COMBINATIONS,
  buildModuleCombinationConfig,
  createModuleEffectRecorder,
  diffPayload,
  diffStateDirectories,
  snapshotStateDirectory,
} from "./module-combination-test-support.js";

function createRequestPayload() {
  return {
    model: "tokenpilot/gpt-5.4-mini",
    prompt_cache_key: "inbound-cache-key",
    instructions: "Keep the implementation precise.",
    input: [
      {
        role: "developer",
        content: "Runtime: agent=baseline-agent | host=demo\nYour working directory is: /tmp/baseline\n\nDeveloper prompt",
      },
      {
        role: "user",
        content: "[2026-07-20 10:00:00] Continue the task.",
      },
      {
        role: "tool",
        toolName: "search",
        content: "T".repeat(3000),
      },
    ],
  };
}

test("all-enabled request behavior remains stable before module decoupling", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-all-enabled-baseline-"));
  try {
    const allEnabled = MODULE_COMBINATIONS.find(({ id }) => id === "all")!;
    const cfg = __testHooks.normalizeConfig({
      stateDir,
      ...buildModuleCombinationConfig(allEnabled.enablement),
      reduction: {
        triggerMinChars: 256,
        maxToolChars: 256,
        passes: {
          toolPayloadTrim: true,
        },
      },
    });
    const payload: any = createRequestPayload();
    const beforePayload = structuredClone(payload);
    const beforeState = await snapshotStateDirectory(stateDir);
    const traceStages: string[] = [];
    const reductionTracePasses: string[] = [];
    let policyCalls = 0;

    const prepared = await __testHooks.prepareProxyRequest({
      cfg,
      payload,
      resolveSessionIdForPayload: () => "session-all-enabled-baseline",
      policyModule: {
        async beforeBuild(turnCtx: any) {
          policyCalls += 1;
          return turnCtx;
        },
      },
      helpers: {
        appendTaskStateTrace: async (_stateDir: string, record: any) => {
          traceStages.push(String(record.stage ?? ""));
        },
        appendReductionPassTrace: async (_stateDir: string, record: any) => {
          for (const entry of record.report ?? []) {
            reductionTracePasses.push(String(entry.id ?? ""));
          }
        },
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });
    const afterState = await snapshotStateDirectory(stateDir);
    const payloadChanges = diffPayload(beforePayload, prepared.payload);
    const stateChanges = diffStateDirectories(beforeState, afterState);
    const reducedTool = prepared.payload.input.find((item: any) => item?.role === "tool");

    assert.equal(policyCalls, 1);
    assert.match(String(prepared.payload.prompt_cache_key), /^runtime-pfx-/);
    assert.notEqual(prepared.payload.prompt_cache_key, "inbound-cache-key");
    assert.equal(prepared.payload.prompt_cache_retention, "24h");
    assert.equal(prepared.requestEnvelope.metadata?.promptCacheRetention, "24h");
    assert.ok(prepared.reductionApplied.changedBlocks > 0);
    assert.ok(prepared.reductionApplied.savedChars > 0);
    assert.match(String(prepared.payload.input[0].content), /Your working directory is: \/tmp\/baseline/);
    assert.match(String(prepared.payload.input[1].content), /WORKDIR: \/tmp\/baseline/);
    assert.ok(String(reducedTool?.content ?? "").length < 3000);
    assert.ok(payloadChanges.some(({ path }) => path === "prompt_cache_key"));
    assert.ok(payloadChanges.some(({ path }) => path === "input[1].content"));
    assert.ok(payloadChanges.some(({ path }) => path.startsWith("input")));
    assert.deepEqual(traceStages, [
      "procedural_memory_retrieval",
      "stable_prefix_rewrite",
      "proxy_reduction_session_resolved",
      "proxy_before_call_rewrite",
    ]);
    assert.ok(reductionTracePasses.includes("tool_payload_trim"));
    assert.ok(stateChanges.some(({ path }) => path === "tokenpilot/proxy-requests.jsonl"));
    assert.ok(stateChanges.some(({ path }) => path === "tokenpilot/visual/stability/session-all-enabled-baseline.jsonl"));
    assert.ok(stateChanges.some(({ path }) => path === "tokenpilot/visual/reduction/session-all-enabled-baseline.jsonl"));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

for (const combination of MODULE_COMBINATIONS) {
  test(`module combination harness captures ${combination.id} request effects`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), `tokenpilot-${combination.id}-`));
    try {
      const cfg = __testHooks.normalizeConfig({
        stateDir,
        ...buildModuleCombinationConfig(combination.enablement),
        memory: { enabled: false },
        reduction: {
          triggerMinChars: 256,
          maxToolChars: 256,
          passes: { toolPayloadTrim: true },
        },
      });
      const payload: any = createRequestPayload();
      const beforePayload = structuredClone(payload);
      const beforeState = await snapshotStateDirectory(stateDir);
      const recorder = createModuleEffectRecorder();
      let policyCalls = 0;
      let reductionCalls = 0;

      const prepared = await __testHooks.prepareProxyRequest({
        cfg,
        payload,
        resolveSessionIdForPayload: () => `session-${combination.id}`,
        policyModule: {
          async beforeBuild(turnCtx: any) {
            policyCalls += 1;
            return turnCtx;
          },
        },
        helpers: {
          buildLayeredReductionContext: combination.enablement.reduction
            ? undefined
            : () => {
              throw new Error("disabled reduction must not build layered context");
            },
          loadOrderedTurnAnchors: combination.enablement.reduction
            ? undefined
            : async () => {
              throw new Error("disabled reduction must not load turn anchors");
            },
          loadSegmentAnchorByCallId: combination.enablement.reduction
            ? undefined
            : async () => {
              throw new Error("disabled reduction must not load segment anchors");
            },
          appendTaskStateTrace: async (_stateDir: string, record: any) => {
            const stage = String(record.stage ?? "");
            const module = stage.includes("reduction") || stage === "proxy_before_call_rewrite"
              ? "reduction"
              : stage.includes("stable_prefix")
                ? "stabilizer"
                : "eviction";
            recorder.recordTrace(module, stage, record);
          },
          appendReductionPassTrace: async (_stateDir: string, record: any) => {
            recorder.recordTrace("reduction", "reduction-pass", record);
          },
          applyProxyReductionToInput: async (...args: any[]) => {
            reductionCalls += 1;
            return __testHooks.applyProxyReductionToInput(args[0], args[1]);
          },
        },
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
        },
      });
      const afterState = await snapshotStateDirectory(stateDir);
      const payloadChanges = diffPayload(beforePayload, prepared.payload);
      const stateChanges = diffStateDirectories(beforeState, afterState);
      const effects = recorder.snapshot();

      assert.equal(reductionCalls, combination.enablement.reduction ? 1 : 0);
      assert.equal(policyCalls, combination.enablement.eviction ? 1 : 0);
      assert.equal(prepared.evictionRun.enabled, combination.enablement.eviction);
      assert.equal(prepared.evictionRun.executed, combination.enablement.eviction);
      assert.equal(prepared.reductionApplied.changedBlocks > 0, combination.enablement.reduction);
      assert.ok(payloadChanges.length > 0);
      assert.ok(stateChanges.some(({ path }) => path === "tokenpilot/proxy-requests.jsonl"));
      assert.equal(effects.stabilizer.traces.length > 0, combination.enablement.stabilizer);
      assert.equal(
        stateChanges.some(({ path }) => path === `tokenpilot/visual/stability/session-${combination.id}.jsonl`),
        combination.enablement.stabilizer,
      );
      assert.ok(effects.reduction.traces.length > 0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}

for (const combination of MODULE_COMBINATIONS.filter(({ enablement }) => !enablement.stabilizer)) {
  test(`stabilizer-disabled ${combination.id} preserves prefix-owned request fields`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), `tokenpilot-prefix-disabled-${combination.id}-`));
    try {
      const cfg = __testHooks.normalizeConfig({
        stateDir,
        ...buildModuleCombinationConfig(combination.enablement),
        memory: { enabled: false },
        reduction: {
          triggerMinChars: 256,
          maxToolChars: 256,
          passes: { toolPayloadTrim: true },
        },
      });
      const payload: any = {
        ...createRequestPayload(),
        prompt_cache_retention: "inbound-retention",
        tools: [
          { type: "function", function: { name: "z_tool", parameters: { z: 1, a: 2 } } },
          { type: "function", function: { name: "a_tool", parameters: { b: true, a: false } } },
        ],
      };
      const originalDeveloper = structuredClone(payload.input[0]);
      const originalUser = structuredClone(payload.input[1]);
      const originalTools = structuredClone(payload.tools);
      const traceStages: string[] = [];

      const prepared = await __testHooks.prepareProxyRequest({
        cfg,
        payload,
        resolveSessionIdForPayload: () => `session-prefix-disabled-${combination.id}`,
        policyModule: {
          async beforeBuild(turnCtx: any) {
            return turnCtx;
          },
        },
        helpers: {
          appendTaskStateTrace: async (_stateDir: string, record: any) => {
            traceStages.push(String(record.stage ?? ""));
          },
        },
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
        },
      });
      const state = await snapshotStateDirectory(stateDir);
      const developerMessages = prepared.payload.input.filter((item: any) => item?.role === "developer");
      const userMessages = prepared.payload.input.filter((item: any) => item?.role === "user");

      assert.deepEqual(developerMessages, [originalDeveloper]);
      assert.deepEqual(userMessages, [originalUser]);
      assert.deepEqual(prepared.payload.tools, originalTools);
      assert.equal(prepared.payload.prompt_cache_key, "inbound-cache-key");
      assert.equal(prepared.payload.prompt_cache_retention, "inbound-retention");
      assert.equal(prepared.requestEnvelope.metadata?.promptCacheKey, "inbound-cache-key");
      assert.equal(prepared.requestEnvelope.metadata?.promptCacheRetention, "inbound-retention");
      assert.equal(traceStages.includes("stable_prefix_rewrite"), false);
      assert.equal(
        `tokenpilot/visual/stability/session-prefix-disabled-${combination.id}.jsonl` in state,
        false,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}
