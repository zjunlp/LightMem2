import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProductSurfaceConfigAdapter,
  ProductSurfaceHostBridge,
  ProductCommandSpec,
} from "@lightmem2/host-adapter";
import { registerProductSurfaceCommands } from "../src/index.js";
import { TEST_PRODUCT_SURFACE_IDENTITY } from "./product-identity-fixture.js";

function createTestConfigAdapter(): ProductSurfaceConfigAdapter {
  return {
    pluginConfigRecord(config) {
      return (config.pluginConfig && typeof config.pluginConfig === "object")
        ? config.pluginConfig as Record<string, unknown>
        : undefined;
    },
    pluginEntryRecord(config) {
      return (config.pluginEntry && typeof config.pluginEntry === "object")
        ? config.pluginEntry as Record<string, unknown>
        : undefined;
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

function createMockHostRuntime(initialConfig: Record<string, unknown>) {
  const registered = new Map<string, ProductCommandSpec>();
  let reportCalls = 0;
  let doctorCalls = 0;
  let visualCalls = 0;

  const config = structuredClone(initialConfig);
  const bridge: ProductSurfaceHostBridge = {
    loadConfig() {
      return structuredClone(config);
    },
    async writeConfig(nextConfig) {
      Object.keys(config).forEach((key) => {
        delete (config as Record<string, unknown>)[key];
      });
      Object.assign(config, structuredClone(nextConfig));
    },
    handleReport() {
      reportCalls += 1;
      return { text: "mock-report" };
    },
    handleDoctor() {
      doctorCalls += 1;
      return { text: "mock-doctor" };
    },
    handleVisual() {
      visualCalls += 1;
      return { text: "mock-visual" };
    },
  };

  return {
    config,
    bridge,
    registerCommand(spec: ProductCommandSpec) {
      registered.set(spec.name, spec);
    },
    getCommand(name: string) {
      return registered.get(name);
    },
    get commandNames() {
      return [...registered.keys()];
    },
    get reportCalls() {
      return reportCalls;
    },
    get doctorCalls() {
      return doctorCalls;
    },
    get visualCalls() {
      return visualCalls;
    },
  };
}

test("mock host e2e registers aliases and executes mode command through registered handler", async () => {
  const host = createMockHostRuntime({
    pluginConfig: {},
    pluginEntry: {},
  });

  registerProductSurfaceCommands({
    identity: TEST_PRODUCT_SURFACE_IDENTITY,
    registrar: {
      registerCommand(spec) {
        host.registerCommand(spec);
      },
    },
    bridge: host.bridge,
    configAdapter: createTestConfigAdapter(),
  });

  assert.deepEqual(host.commandNames.sort(), ["lightmem2", "tokenpilot", "tp"]);

  const command = host.getCommand("lightmem2");
  assert.ok(command, "expected lightmem2 alias to be registered");

  const result = await command.handler({ args: "mode aggressive" });

  assert.equal(result.text, "✅ Runtime mode = aggressive");
  const pluginCfg = host.config.pluginConfig as Record<string, unknown>;
  const pluginEntry = host.config.pluginEntry as Record<string, unknown>;
  assert.equal(pluginEntry.enabled, true);
  assert.equal(pluginCfg.enabled, true);
  assert.equal(pluginCfg.hostDefaultApplied, true);
  assert.equal(((pluginCfg.modules as Record<string, unknown>).eviction), true);
  assert.equal(((pluginCfg.eviction as Record<string, unknown>).enabled), true);
  assert.equal(((pluginCfg.taskStateEstimator as Record<string, unknown>).enabled), true);
});

test("mock host e2e executes feature commands through registered alias handlers", async () => {
  const host = createMockHostRuntime({
    pluginConfig: { stateDir: "/tmp/mock-host-tokenpilot" },
    pluginEntry: {},
  });

  registerProductSurfaceCommands({
    identity: TEST_PRODUCT_SURFACE_IDENTITY,
    registrar: {
      registerCommand(spec) {
        host.registerCommand(spec);
      },
    },
    bridge: host.bridge,
    configAdapter: createTestConfigAdapter(),
  });

  const tokenpilot = host.getCommand("tokenpilot");
  const tp = host.getCommand("tp");
  assert.ok(tokenpilot, "expected tokenpilot alias to be registered");
  assert.ok(tp, "expected tp alias to be registered");

  const report = await tokenpilot.handler({ args: "report" });
  const doctor = await tp.handler({ args: "doctor" });
  const visual = await tokenpilot.handler({ args: "visual" });

  assert.equal(report.text, "mock-report");
  assert.equal(doctor.text, "mock-doctor");
  assert.equal(visual.text, "mock-visual");
  assert.equal(host.reportCalls, 1);
  assert.equal(host.doctorCalls, 1);
  assert.equal(host.visualCalls, 1);
});

test("mock host e2e preserves shared handler semantics across aliases", async () => {
  const host = createMockHostRuntime({
    pluginConfig: {},
    pluginEntry: {},
  });

  registerProductSurfaceCommands({
    identity: TEST_PRODUCT_SURFACE_IDENTITY,
    registrar: {
      registerCommand(spec) {
        host.registerCommand(spec);
      },
    },
    bridge: host.bridge,
    configAdapter: createTestConfigAdapter(),
  });

  const lightmem2 = host.getCommand("lightmem2");
  const tokenpilot = host.getCommand("tokenpilot");
  assert.ok(lightmem2 && tokenpilot, "expected both aliases to be registered");
  assert.equal(lightmem2.handler, tokenpilot.handler);

  const detailsResult = await lightmem2.handler({ args: "settings details on" });
  const reductionResult = await tokenpilot.handler({ args: "reduction pass toolPayloadTrim off" });

  assert.equal(detailsResult.text, "✅ ux.details = true");
  assert.equal(reductionResult.text, "✅ reduction.toolPayloadTrim = false");
  const pluginCfg = host.config.pluginConfig as Record<string, unknown>;
  assert.equal(((pluginCfg.ux as Record<string, unknown>).details), true);
  assert.equal(
    (((pluginCfg.reduction as Record<string, unknown>).passes as Record<string, unknown>).toolPayloadTrim),
    false,
  );
});
