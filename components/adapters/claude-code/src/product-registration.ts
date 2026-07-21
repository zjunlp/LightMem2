import { readLatestUxEffect } from "@lightmem2/host-adapter";
import { defineProductHostRegistration } from "@lightmem2/product-surface";
import {
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
} from "./config.js";
import { CLAUDE_CODE_TOKENPILOT_HOST_BINDING } from "./preset.js";

export const CLAUDE_CODE_PRODUCT_HOST_REGISTRATION = defineProductHostRegistration({
  hostId: "claude-code",
  displayName: "Claude Code",
  preset: CLAUDE_CODE_TOKENPILOT_HOST_BINDING,
  async resolveStateDir(context) {
    const config = await loadTokenPilotClaudeCodeConfig(
      context?.productConfigPath?.trim() || defaultTokenPilotClaudeCodeConfigPath(),
    );
    return typeof config.stateDir === "string" ? config.stateDir : undefined;
  },
  readLatestActivity: readLatestUxEffect,
});
