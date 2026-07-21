import assert from "node:assert/strict";
import test from "node:test";

import type {
  TokenPilotProductCommandRegistrar,
  TokenPilotRegisteredCommandSpec,
  TokenPilotProductSurfaceConfigAdapter,
  TokenPilotProductSurfaceHostBridge,
} from "@lightmem2/host-adapter";
import {
  createProductSurfaceCommandHandler,
  DEFAULT_TOKENPILOT_COMMAND_ALIASES,
  registerProductSurfaceCommands,
} from "../src/index.js";

function createTestConfigAdapter(): TokenPilotProductSurfaceConfigAdapter {
  return {
    pluginConfigRecord(config) {
      return (config.pluginConfig && typeof config.pluginConfig === "object") ? config.pluginConfig as Record<string, unknown> : undefined;
    },
    pluginEntryRecord(config) {
      return (config.pluginEntry && typeof config.pluginEntry === "object") ? config.pluginEntry as Record<string, unknown> : undefined;
    },
    ensurePluginConfig(config) {
      if (!config.pluginConfig || typeof config.pluginConfig !== "object" || Array.isArray(config.pluginConfig)) {
        config.pluginConfig = {};
      }
      return config.pluginConfig as Record<string, unknown>;
    },
    ensurePluginEntry(config) {
      if (!config.pluginEntry || typeof config.pluginEntry !== "object" || Array.isArray(config.pluginEntry)) {
        config.pluginEntry = {};
      }
      return config.pluginEntry as Record<string, unknown>;
    },
    resolveStateDir(config) {
      const pluginCfg = this.pluginConfigRecord(config);
      return typeof pluginCfg?.stateDir === "string" ? pluginCfg.stateDir : undefined;
    },
    setRuntimeHostDefaults(config) {
      const pluginCfg = this.ensurePluginConfig(config);
      pluginCfg.hostDefaultApplied = true;
    },
  };
}

function createTestBridge(config: Record<string, unknown>): TokenPilotProductSurfaceHostBridge & {
  writes: Record<string, unknown>[];
  reportCalls: number;
  doctorCalls: number;
  visualCalls: number;
} {
  const writes: Record<string, unknown>[] = [];
  let reportCalls = 0;
  let doctorCalls = 0;
  let visualCalls = 0;

  return {
    writes,
    get reportCalls() {
      return reportCalls;
    },
    get doctorCalls() {
      return doctorCalls;
    },
    get visualCalls() {
      return visualCalls;
    },
    loadConfig() {
      return structuredClone(config);
    },
    async writeConfig(nextConfig) {
      writes.push(structuredClone(nextConfig));
      Object.assign(config, structuredClone(nextConfig));
    },
    handleReport() {
      reportCalls += 1;
      return { text: "report-ok" };
    },
    handleDoctor() {
      doctorCalls += 1;
      return { text: "doctor-ok" };
    },
    handleVisual() {
      visualCalls += 1;
      return { text: "visual-ok" };
    },
  };
}

test("registerProductSurfaceCommands registers default aliases with shared handler", () => {
  const configAdapter = createTestConfigAdapter();
  const bridge = createTestBridge({});
  const specs: TokenPilotRegisteredCommandSpec[] = [];
  const registrar: TokenPilotProductCommandRegistrar = {
    registerCommand(spec) {
      specs.push(spec);
    },
  };

  registerProductSurfaceCommands({
    registrar,
    bridge,
    configAdapter,
  });

  assert.deepEqual(
    specs.map((spec) => spec.name),
    DEFAULT_TOKENPILOT_COMMAND_ALIASES.map((alias) => alias.name),
  );
  assert.ok(specs.every((spec) => spec.acceptsArgs === true));
  assert.ok(specs.every((spec) => spec.handler === specs[0]?.handler));
});

test("createProductSurfaceCommandHandler applies runtime mode and host defaults", async () => {
  const config: Record<string, unknown> = {
    pluginConfig: {},
    pluginEntry: {},
  };
  const handler = createProductSurfaceCommandHandler({
    bridge: createTestBridge(config),
    configAdapter: createTestConfigAdapter(),
  });

  const result = await handler({ args: "mode aggressive" });

  assert.equal(result.text, "✅ Runtime mode = aggressive");
  const pluginCfg = config.pluginConfig as Record<string, unknown>;
  const pluginEntry = config.pluginEntry as Record<string, unknown>;
  assert.equal(pluginEntry.enabled, true);
  assert.equal(pluginCfg.enabled, true);
  assert.equal(pluginCfg.hostDefaultApplied, true);
  assert.deepEqual(pluginCfg.modules, {
    stabilizer: true,
    policy: true,
    reduction: true,
    eviction: true,
  });
  assert.equal((pluginCfg.eviction as Record<string, unknown>).enabled, true);
  assert.equal((pluginCfg.taskStateEstimator as Record<string, unknown>).enabled, true);
});

test("createProductSurfaceCommandHandler returns shared payload for built-only host features", async () => {
  const config: Record<string, unknown> = {
    pluginConfig: {},
    pluginEntry: {},
  };
  const handler = createProductSurfaceCommandHandler({
    bridge: {
      loadConfig() {
        return structuredClone(config);
      },
      async writeConfig(nextConfig) {
        Object.assign(config, structuredClone(nextConfig));
      },
      buildDoctorPayload() {
        return {
          kind: "doctor",
          data: {
            ok: true,
          },
        };
      },
    },
    configAdapter: createTestConfigAdapter(),
  });

  const result = await handler({ args: "doctor" });
  assert.equal(result.text.includes("TokenPilot commands:"), true);
  assert.deepEqual(result.payload, {
    kind: "doctor",
    data: {
      ok: true,
    },
  });
});

test("createProductSurfaceCommandHandler returns built host payloads for report and visual fallbacks", async () => {
  const config: Record<string, unknown> = {
    pluginConfig: {},
    pluginEntry: {},
  };
  const handler = createProductSurfaceCommandHandler({
    bridge: {
      loadConfig() {
        return structuredClone(config);
      },
      async writeConfig(nextConfig) {
        Object.assign(config, structuredClone(nextConfig));
      },
      buildReportPayload() {
        return {
          kind: "report",
          data: {
            sessionId: "session-1",
          },
        };
      },
      buildVisualPayload() {
        return {
          kind: "visual",
          data: {
            url: "http://127.0.0.1:18789/tokenpilot/visual",
          },
        };
      },
    },
    configAdapter: createTestConfigAdapter(),
  });

  const report = await handler({ args: "report" });
  const visual = await handler({ args: "visual" });

  assert.match(report.text, /TokenPilot commands:/);
  assert.deepEqual(report.payload, {
    kind: "report",
    data: {
      sessionId: "session-1",
    },
  });
  assert.match(visual.text, /TokenPilot commands:/);
  assert.deepEqual(visual.payload, {
    kind: "visual",
    data: {
      url: "http://127.0.0.1:18789/tokenpilot/visual",
    },
  });
});

test("createProductSurfaceCommandHandler updates reduction pass and settings details", async () => {
  const config: Record<string, unknown> = {
    pluginConfig: {},
    pluginEntry: {},
  };
  const bridge = createTestBridge(config);
  const handler = createProductSurfaceCommandHandler({
    bridge,
    configAdapter: createTestConfigAdapter(),
  });

  const reductionResult = await handler({ args: "reduction pass toolPayloadTrim off" });
  const settingsResult = await handler({ args: "settings details on" });

  assert.equal(reductionResult.text, "✅ reduction.toolPayloadTrim = false");
  assert.equal(settingsResult.text, "✅ ux.details = true");
  const pluginCfg = config.pluginConfig as Record<string, unknown>;
  assert.equal(
    (((pluginCfg.reduction as Record<string, unknown>).passes as Record<string, unknown>).toolPayloadTrim),
    false,
  );
  assert.equal((((pluginCfg.ux as Record<string, unknown>).details)), true);
  assert.equal(bridge.writes.length, 2);
});

test("createProductSurfaceCommandHandler applies reduction mode presets", async () => {
  const config: Record<string, unknown> = {
    pluginConfig: {},
    pluginEntry: {},
  };
  const handler = createProductSurfaceCommandHandler({
    bridge: createTestBridge(config),
    configAdapter: createTestConfigAdapter(),
  });

  const lightResult = await handler({ args: "reduction mode light" });
  let pluginCfg = config.pluginConfig as Record<string, unknown>;
  let reduction = pluginCfg.reduction as Record<string, unknown>;
  let passes = reduction.passes as Record<string, unknown>;
  let passOptions = reduction.passOptions as Record<string, Record<string, unknown>>;
  assert.equal(lightResult.text, "✅ Observation Reduction preset = light");
  assert.equal(reduction.triggerMinChars, 4000);
  assert.equal(reduction.maxToolChars, 1800);
  assert.equal(passes.readStateCompaction, true);
  assert.equal(passes.toolPayloadTrim, true);
  assert.equal(passes.htmlSlimming, false);
  assert.equal(passes.execOutputTruncation, false);
  assert.equal(passes.agentsStartupOptimization, true);
  assert.equal((passOptions.formatSlimming?.enabled), false);
  assert.equal((passOptions.pathTruncation?.enabled), false);

  const balancedResult = await handler({ args: "reduction mode balanced" });
  pluginCfg = config.pluginConfig as Record<string, unknown>;
  reduction = pluginCfg.reduction as Record<string, unknown>;
  passes = reduction.passes as Record<string, unknown>;
  passOptions = reduction.passOptions as Record<string, Record<string, unknown>>;
  assert.equal(balancedResult.text, "✅ Observation Reduction preset = balanced");
  assert.equal(reduction.triggerMinChars, 2200);
  assert.equal(reduction.maxToolChars, 1200);
  assert.equal(passes.htmlSlimming, true);
  assert.equal(passes.execOutputTruncation, true);
  assert.equal((passOptions.formatSlimming?.enabled), true);
  assert.equal((passOptions.formatCleaning?.enabled), true);
  assert.equal((passOptions.imageDownsample?.enabled), true);

  const aggressiveResult = await handler({ args: "reduction mode aggressive" });
  pluginCfg = config.pluginConfig as Record<string, unknown>;
  reduction = pluginCfg.reduction as Record<string, unknown>;
  assert.equal(aggressiveResult.text, "✅ Observation Reduction preset = aggressive");
  assert.equal(reduction.triggerMinChars, 1400);
  assert.equal(reduction.maxToolChars, 900);
});

test("createProductSurfaceCommandHandler updates stabilizer hook and target", async () => {
  const config: Record<string, unknown> = {
    pluginConfig: {},
    pluginEntry: {},
  };
  const handler = createProductSurfaceCommandHandler({
    bridge: createTestBridge(config),
    configAdapter: createTestConfigAdapter(),
  });

  const hookResult = await handler({ args: "stabilizer hook on" });
  const targetResult = await handler({ args: "stabilizer target developer" });

  assert.equal(hookResult.text, "✅ hooks.beforeToolCall = true");
  assert.equal(targetResult.text, "✅ hooks.dynamicContextTarget = developer");
  const pluginCfg = config.pluginConfig as Record<string, unknown>;
  assert.equal(((pluginCfg.hooks as Record<string, unknown>).beforeToolCall), true);
  assert.equal(((pluginCfg.hooks as Record<string, unknown>).dynamicContextTarget), "developer");
});

test("createProductSurfaceCommandHandler updates eviction estimator and set values", async () => {
  const config: Record<string, unknown> = {
    pluginConfig: {},
    pluginEntry: {},
  };
  const handler = createProductSurfaceCommandHandler({
    bridge: createTestBridge(config),
    configAdapter: createTestConfigAdapter(),
  });

  const estimatorResult = await handler({ args: "eviction estimator on" });
  const setPolicyResult = await handler({ args: "eviction set policy lru" });
  const setLookaheadResult = await handler({ args: "eviction set evictionLookaheadTurns 7" });

  assert.equal(estimatorResult.text, "✅ taskStateEstimator.enabled = true");
  assert.equal(setPolicyResult.text, "✅ eviction.policy = lru");
  assert.equal(setLookaheadResult.text, "✅ taskStateEstimator.evictionLookaheadTurns = 7");
  const pluginCfg = config.pluginConfig as Record<string, unknown>;
  assert.equal(((pluginCfg.taskStateEstimator as Record<string, unknown>).enabled), true);
  assert.equal(((pluginCfg.eviction as Record<string, unknown>).policy), "lru");
  assert.equal(((pluginCfg.taskStateEstimator as Record<string, unknown>).evictionLookaheadTurns), 7);
});

test("createProductSurfaceCommandHandler toggles eviction and estimator linkage", async () => {
  const config: Record<string, unknown> = {
    pluginConfig: {},
    pluginEntry: {},
  };
  const handler = createProductSurfaceCommandHandler({
    bridge: createTestBridge(config),
    configAdapter: createTestConfigAdapter(),
  });

  const onResult = await handler({ args: "eviction on" });
  let pluginCfg = config.pluginConfig as Record<string, unknown>;
  assert.equal(onResult.text, "✅ Lifecycle-Aware Eviction enabled");
  assert.equal(((pluginCfg.modules as Record<string, unknown>).eviction), true);
  assert.equal(((pluginCfg.eviction as Record<string, unknown>).enabled), true);
  assert.equal(((pluginCfg.taskStateEstimator as Record<string, unknown>).enabled), true);

  const offResult = await handler({ args: "eviction off" });
  pluginCfg = config.pluginConfig as Record<string, unknown>;
  assert.equal(offResult.text, "✅ Lifecycle-Aware Eviction disabled");
  assert.equal(((pluginCfg.modules as Record<string, unknown>).eviction), false);
  assert.equal(((pluginCfg.eviction as Record<string, unknown>).enabled), false);
  assert.equal(((pluginCfg.taskStateEstimator as Record<string, unknown>).enabled), false);
});

test("createProductSurfaceCommandHandler returns usage text for invalid stabilizer and eviction args", async () => {
  const handler = createProductSurfaceCommandHandler({
    bridge: createTestBridge({ pluginConfig: {}, pluginEntry: {} }),
    configAdapter: createTestConfigAdapter(),
  });

  const stabilizerHookUsage = await handler({ args: "stabilizer hook maybe" });
  const stabilizerTargetUsage = await handler({ args: "stabilizer target admin" });
  const evictionEstimatorUsage = await handler({ args: "eviction estimator maybe" });
  const evictionSetUsage = await handler({ args: "eviction set unknownKey 3" });

  assert.equal(stabilizerHookUsage.text, "Usage: /tokenpilot stabilizer hook <on|off>");
  assert.equal(stabilizerTargetUsage.text, "Usage: /tokenpilot stabilizer target <developer|user>");
  assert.equal(evictionEstimatorUsage.text, "Usage: /tokenpilot eviction estimator <on|off>");
  assert.equal(evictionSetUsage.text, "Usage: /tokenpilot eviction set <key> <value>");
});

test("createProductSurfaceCommandHandler routes host feature commands", async () => {
  const config: Record<string, unknown> = {
    pluginConfig: { stateDir: "/tmp/tokenpilot-test" },
    pluginEntry: {},
  };
  const bridge = createTestBridge(config);
  const handler = createProductSurfaceCommandHandler({
    bridge,
    configAdapter: createTestConfigAdapter(),
  });

  const report = await handler({ args: "report" });
  const doctor = await handler({ args: "doctor" });
  const visual = await handler({ args: "visual" });

  assert.equal(report.text, "report-ok");
  assert.equal(doctor.text, "doctor-ok");
  assert.equal(visual.text, "visual-ok");
  assert.equal(bridge.reportCalls, 1);
  assert.equal(bridge.doctorCalls, 1);
  assert.equal(bridge.visualCalls, 1);
});

test("createProductSurfaceCommandHandler falls back to help for unknown actions", async () => {
  const handler = createProductSurfaceCommandHandler({
    bridge: createTestBridge({ pluginConfig: {}, pluginEntry: {} }),
    configAdapter: createTestConfigAdapter(),
  });

  const result = await handler({ args: "unknown-subcommand" });

  assert.match(result.text, /TokenPilot commands:/);
});
