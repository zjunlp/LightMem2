import {
  createTokenPilotHostBinding,
  initializeTokenPilotPreset,
} from "@tokenpilot/decision";

export const CLAUDE_CODE_TOKENPILOT_HOST_BINDING = createTokenPilotHostBinding({
  hostId: "claude-code",
  supportedFeatures: ["stabilizer", "reduction"],
});

export function initializeClaudeCodeTokenPilotPreset(): void {
  initializeTokenPilotPreset(CLAUDE_CODE_TOKENPILOT_HOST_BINDING);
}
