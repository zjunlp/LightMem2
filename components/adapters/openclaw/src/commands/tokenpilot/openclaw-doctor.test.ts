import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatOpenClawDoctorReport, inspectOpenClawDoctor } from "./openclaw-doctor.js";

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tokenpilot-openclaw-doctor-"));
}

function baseConfig(stateRoot: string): Record<string, unknown> {
  return {
    plugins: {
      allow: ["tokenpilot"],
      slots: {
        contextEngine: "layered-context",
      },
      entries: {
        tokenpilot: {
          enabled: true,
          config: {
            enabled: true,
            stateDir: join(stateRoot, "tokenpilot-state"),
          },
        },
      },
    },
    tools: {
      profile: "coding",
      alsoAllow: ["memory_fault_recover"],
    },
    agents: {
      defaults: {
        models: {
          "lightmem2/gpt-5.4-mini": {},
        },
      },
    },
  };
}

test("inspectOpenClawDoctor passes when release install invariants are present", async () => {
  const root = makeTempRoot();
  const configPath = join(root, ".openclaw", "openclaw.json");
  const extensionPath = join(root, ".openclaw", "extensions", "tokenpilot");
  const stateDir = join(root, ".openclaw", "tokenpilot-state");
  mkdirSync(join(root, ".openclaw"), { recursive: true });
  mkdirSync(extensionPath, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configPath, "{}\n", "utf8");

  process.env.OPENCLAW_STATE_DIR = join(root, ".openclaw");
  process.env.OPENCLAW_CONFIG_PATH = configPath;

  try {
    const report = inspectOpenClawDoctor(baseConfig(join(root, ".openclaw")));
    assert.equal(report.ok, true);
    assert.equal(report.checks.every((check) => check.ok), true);
    assert.match(formatOpenClawDoctorReport(report), /plugins\.slots\.contextEngine: layered-context/);
    assert.doesNotMatch(formatOpenClawDoctorReport(report), /Suggested fixes:/);
  } finally {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspectOpenClawDoctor accepts a legacy state dir when the canonical dir has not been created yet", async () => {
  const root = makeTempRoot();
  const configPath = join(root, ".openclaw", "openclaw.json");
  const extensionPath = join(root, ".openclaw", "extensions", "tokenpilot");
  const legacyStateDir = join(root, ".openclaw", "tokenpilot-plugin-state");
  mkdirSync(join(root, ".openclaw"), { recursive: true });
  mkdirSync(extensionPath, { recursive: true });
  mkdirSync(legacyStateDir, { recursive: true });
  writeFileSync(configPath, "{}\n", "utf8");

  process.env.OPENCLAW_STATE_DIR = join(root, ".openclaw");
  process.env.OPENCLAW_CONFIG_PATH = configPath;

  try {
    const report = inspectOpenClawDoctor({
      plugins: {
        allow: ["tokenpilot"],
        slots: {
          contextEngine: "layered-context",
        },
        entries: {
          tokenpilot: {
            enabled: true,
            config: {
              enabled: true,
              stateDir: legacyStateDir,
            },
          },
        },
      },
      tools: {
        profile: "coding",
        alsoAllow: ["memory_fault_recover"],
      },
      agents: {
        defaults: {
          models: {
            "lightmem2/gpt-5.4-mini": {},
          },
        },
      },
    });
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((check) => check.key === "stateDirCanonical")?.ok, true);
  } finally {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspectOpenClawDoctor reports config drift with targeted fixes", async () => {
  const root = makeTempRoot();
  const configPath = join(root, ".openclaw", "openclaw.json");
  const stateRoot = join(root, ".openclaw");
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(configPath, "{}\n", "utf8");

  process.env.OPENCLAW_STATE_DIR = stateRoot;
  process.env.OPENCLAW_CONFIG_PATH = configPath;

  try {
    const report = inspectOpenClawDoctor({
      plugins: {
        allow: [],
        slots: {
          contextEngine: "default",
        },
        entries: {
          tokenpilot: {
            enabled: false,
            config: {
              enabled: false,
              stateDir: join(stateRoot, "missing-state"),
            },
          },
        },
      },
      tools: {
        profile: "analysis",
        allow: [],
        alsoAllow: [],
      },
      agents: {
        defaults: {
          models: {},
        },
      },
    });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.key === "pluginAllowed")?.ok, false);
    assert.equal(report.checks.find((check) => check.key === "contextEngineSlot")?.ok, false);
    assert.equal(report.checks.find((check) => check.key === "memoryFaultRecover")?.detail, "memory_fault_recover is not allowed");
    const rendered = formatOpenClawDoctorReport(report);
    assert.match(rendered, /plugins\.allow includes tokenpilot: false/);
    assert.match(rendered, /plugins\.slots\.contextEngine: default/);
    assert.match(rendered, /repair the `plugins\.entries\.tokenpilot`, `plugins\.allow`, and `plugins\.slots\.contextEngine` sections/);
    assert.match(rendered, /tools\.profile` is `coding` and `memory_fault_recover` is allowed/);
  } finally {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspectOpenClawDoctor reports missing config path", async () => {
  const root = makeTempRoot();
  const missingConfigPath = join(root, ".openclaw", "missing.json");
  process.env.OPENCLAW_STATE_DIR = join(root, ".openclaw");
  process.env.OPENCLAW_CONFIG_PATH = missingConfigPath;

  try {
    const report = inspectOpenClawDoctor();
    assert.equal(report.ok, false);
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0]?.key, "config");
    const rendered = formatOpenClawDoctorReport(report);
    assert.match(rendered, /OpenClaw config file not found/);
    assert.match(rendered, /recreate the OpenClaw TokenPilot install/);
  } finally {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    rmSync(root, { recursive: true, force: true });
  }
});
