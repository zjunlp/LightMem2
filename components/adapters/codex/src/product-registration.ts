import { readLatestUxEffect } from "@tokenpilot/host-adapter";
import { defineProductHostRegistration } from "@tokenpilot/product-surface";
import { defaultTokenPilotConfigPath, loadTokenPilotCodexConfig } from "./config.js";
import { CODEX_TOKENPILOT_HOST_BINDING } from "./preset.js";

export const CODEX_PRODUCT_HOST_REGISTRATION = defineProductHostRegistration({
  hostId: "codex",
  displayName: "Codex",
  preset: CODEX_TOKENPILOT_HOST_BINDING,
  async resolveStateDir(context) {
    const config = await loadTokenPilotCodexConfig(
      context?.productConfigPath?.trim() || defaultTokenPilotConfigPath(),
    );
    return typeof config.stateDir === "string" ? config.stateDir : undefined;
  },
  readLatestActivity: readLatestUxEffect,
});
