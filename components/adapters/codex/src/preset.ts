import {
  createTokenPilotHostBinding,
  initializeTokenPilotPreset,
} from "@lightmem2/tokenpilot";

export const CODEX_TOKENPILOT_HOST_BINDING = createTokenPilotHostBinding({
  hostId: "codex",
  supportedFeatures: ["stabilizer", "reduction"],
});

export function initializeCodexTokenPilotPreset(): void {
  initializeTokenPilotPreset(CODEX_TOKENPILOT_HOST_BINDING);
}
