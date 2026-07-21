import { readFile } from "node:fs/promises";
import { defineProductHostRegistration } from "@tokenpilot/product-surface";
import { resolveStateDir } from "./commands/tokenpilot/host-config-adapter.js";
import { resolveOpenClawConfigPath } from "./context-stack/integration/openclaw-paths.js";
import { readLatestUxEffect } from "./context-stack/integration/ux-effects.js";
import { OPENCLAW_TOKENPILOT_HOST_BINDING } from "./preset.js";

export const OPENCLAW_PRODUCT_HOST_REGISTRATION = defineProductHostRegistration({
  hostId: "openclaw",
  displayName: "OpenClaw",
  preset: OPENCLAW_TOKENPILOT_HOST_BINDING,
  async resolveStateDir(context) {
    const configPath = context?.productConfigPath?.trim() || resolveOpenClawConfigPath();
    try {
      return resolveStateDir(JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>);
    } catch {
      return undefined;
    }
  },
  readLatestActivity: readLatestUxEffect,
});
