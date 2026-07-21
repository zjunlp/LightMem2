import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getNestedValue } from "@lightmem2/product-surface";
import {
  resolveDefaultOpenClawTokenPilotStateDir,
  resolveOpenClawCanonicalTokenPilotStateDir,
  resolveOpenClawConfigPath,
  resolveOpenClawLegacyTokenPilotStateDir,
  resolveOpenClawStateRoot,
} from "../../context-stack/integration/openclaw-paths.js";
import { pluginConfigRecord } from "./host-config-adapter.js";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type OpenClawDoctorCheck = {
  key: string;
  ok: boolean;
  detail: string;
};

export type OpenClawDoctorReport = {
  ok: boolean;
  stateRoot: string;
  configPath: string;
  extensionPath: string;
  stateDir: string;
  checks: OpenClawDoctorCheck[];
};

function remediationLines(report: OpenClawDoctorReport): string[] {
  const failing = new Set(report.checks.filter((check) => !check.ok).map((check) => check.key));
  const fixes: string[] = [];

  if (failing.has("config")) {
    fixes.push("- run `npm run install:release` in `components/adapters/openclaw` to recreate the OpenClaw TokenPilot install");
    return fixes;
  }
  if (failing.has("extensionPath")) {
    fixes.push("- rerun `npm run install:release` to reinstall the packaged OpenClaw extension under `~/.openclaw/extensions/tokenpilot`");
  }
  if (failing.has("pluginEntry") || failing.has("runtimeConfig") || failing.has("pluginAllowed") || failing.has("contextEngineSlot")) {
    fixes.push("- rerun `npm run install:release` or repair the `plugins.entries.tokenpilot`, `plugins.allow`, and `plugins.slots.contextEngine` sections in `openclaw.json`");
  }
  if (failing.has("toolsProfile") || failing.has("memoryFaultRecover")) {
    fixes.push("- update the `tools` section in `openclaw.json` so `tools.profile` is `coding` and `memory_fault_recover` is allowed");
  }
  if (failing.has("stateDir")) {
    fixes.push("- create the TokenPilot state directory or point `plugins.entries.tokenpilot.config.stateDir` to an existing writable path");
  }
  if (failing.has("modelNamespace")) {
    fixes.push("- refresh the registered runtime model aliases and restart the OpenClaw gateway so `tokenpilot/<model>` or `lightmem2/<model>` is available");
  }
  return fixes;
}

export function inspectOpenClawDoctor(currentConfig?: Record<string, unknown>): OpenClawDoctorReport {
  const stateRoot = resolveOpenClawStateRoot();
  const configPath = resolveOpenClawConfigPath();
  const extensionPath = join(stateRoot, "extensions", "tokenpilot");
  const canonicalStateDir = resolveOpenClawCanonicalTokenPilotStateDir();
  const legacyStateDir = resolveOpenClawLegacyTokenPilotStateDir();
  const expectedStateDir = resolveDefaultOpenClawTokenPilotStateDir();
  const recognizedStateDirs = new Set([canonicalStateDir, legacyStateDir]);

  if (!existsSync(configPath)) {
    return {
      ok: false,
      stateRoot,
      configPath,
      extensionPath,
      stateDir: expectedStateDir,
      checks: [
        {
          key: "config",
          ok: false,
          detail: "OpenClaw config file not found.",
        },
      ],
    };
  }

  let config = currentConfig;
  if (!config) {
    config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  }

  const pluginCfg = pluginConfigRecord(config) ?? {};
  const stateDir = normalizeText(getNestedValue(pluginCfg, ["stateDir"])) || expectedStateDir;
  const pluginAllow = Array.isArray(getNestedValue(config, ["plugins", "allow"])) ? getNestedValue(config, ["plugins", "allow"]) as unknown[] : [];
  const allow = Array.isArray(getNestedValue(config, ["tools", "allow"])) ? getNestedValue(config, ["tools", "allow"]) as unknown[] : [];
  const alsoAllow = Array.isArray(getNestedValue(config, ["tools", "alsoAllow"])) ? getNestedValue(config, ["tools", "alsoAllow"]) as unknown[] : [];
  const modelKeys = getNestedValue(config, ["agents", "defaults", "models"]);
  const registeredModelKeys = modelKeys && typeof modelKeys === "object"
    ? Object.keys(modelKeys as Record<string, unknown>)
    : [];
  const hasRuntimeModelNamespace = registeredModelKeys.some((key) => key.startsWith("tokenpilot/") || key.startsWith("lightmem2/"));
  const contextEngineSlot = normalizeText(getNestedValue(config, ["plugins", "slots", "contextEngine"]));
  const memoryFaultRecoverLocation = allow.includes("memory_fault_recover")
    ? "tools.allow"
    : alsoAllow.includes("memory_fault_recover")
      ? "tools.alsoAllow"
      : "";

  const checks: OpenClawDoctorCheck[] = [
    {
      key: "pluginEntry",
      ok: getNestedValue(config, ["plugins", "entries", "tokenpilot", "enabled"]) === true,
      detail: `plugin entry enabled: ${getNestedValue(config, ["plugins", "entries", "tokenpilot", "enabled"]) === true}`,
    },
    {
      key: "runtimeConfig",
      ok: getNestedValue(pluginCfg, ["enabled"]) === true,
      detail: `runtime config enabled: ${getNestedValue(pluginCfg, ["enabled"]) === true}`,
    },
    {
      key: "pluginAllowed",
      ok: pluginAllow.includes("tokenpilot"),
      detail: `plugins.allow includes tokenpilot: ${pluginAllow.includes("tokenpilot")}`,
    },
    {
      key: "contextEngineSlot",
      ok: contextEngineSlot === "layered-context",
      detail: `plugins.slots.contextEngine: ${contextEngineSlot || "(unset)"}`,
    },
    {
      key: "toolsProfile",
      ok: normalizeText(getNestedValue(config, ["tools", "profile"])) === "coding",
      detail: `tools.profile: ${normalizeText(getNestedValue(config, ["tools", "profile"])) || "(unset)"}`,
    },
    {
      key: "memoryFaultRecover",
      ok: Boolean(memoryFaultRecoverLocation),
      detail: memoryFaultRecoverLocation
        ? `memory_fault_recover is allowed via ${memoryFaultRecoverLocation}`
        : "memory_fault_recover is not allowed",
    },
    {
      key: "extensionPath",
      ok: existsSync(extensionPath),
      detail: `installed extension directory exists: ${existsSync(extensionPath)}`,
    },
    {
      key: "stateDir",
      ok: existsSync(stateDir),
      detail: `plugin state dir exists: ${existsSync(stateDir)} (${stateDir})`,
    },
    {
      key: "stateDirCanonical",
      ok: recognizedStateDirs.has(stateDir),
      detail: `canonical state dir: ${canonicalStateDir} (legacy exists: ${existsSync(legacyStateDir)})`,
    },
    {
      key: "modelNamespace",
      ok: hasRuntimeModelNamespace,
      detail: hasRuntimeModelNamespace
        ? `runtime model aliases include: ${registeredModelKeys.filter((key) => key.startsWith("tokenpilot/") || key.startsWith("lightmem2/")).join(", ")}`
        : "tokenpilot/<model> or lightmem2/<model> namespace is not registered in agents.defaults.models",
    },
  ];

  return {
    ok: checks.every((item) => item.ok),
    stateRoot,
    configPath,
    extensionPath,
    stateDir,
    checks,
  };
}

export function formatOpenClawDoctorReport(report: OpenClawDoctorReport): string {
  const lines = [
    "TokenPilot OpenClaw doctor:",
    `- state root: ${report.stateRoot}`,
    `- config path: ${report.configPath}`,
    `- extension path: ${report.extensionPath}`,
    `- state dir: ${report.stateDir}`,
    ...report.checks.map((check) => `- ${check.ok ? "OK" : "WARN"} ${check.detail}`),
  ];

  const fixes = remediationLines(report);
  if (fixes.length > 0) {
    lines.push("");
    lines.push("Suggested fixes:");
    lines.push(...fixes);
  }

  return lines.join("\n");
}
