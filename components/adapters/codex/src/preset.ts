import {
  createTokenPilotHostBinding,
  initializeTokenPilotPreset,
} from "@tokenpilot/decision";

export const CODEX_TOKENPILOT_HOST_BINDING = createTokenPilotHostBinding({
  hostId: "codex",
  supportedFeatures: ["stabilizer", "reduction"],
});

export function initializeCodexTokenPilotPreset(): void {
  initializeTokenPilotPreset(CODEX_TOKENPILOT_HOST_BINDING);
}
