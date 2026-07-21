import {
  createTokenPilotHostBinding,
  initializeTokenPilotPreset,
} from "@tokenpilot/decision";

export const OPENCLAW_TOKENPILOT_HOST_BINDING = createTokenPilotHostBinding({
  hostId: "openclaw",
  supportedFeatures: ["stabilizer", "reduction", "eviction"],
});

export function initializeOpenClawTokenPilotPreset(): void {
  initializeTokenPilotPreset(OPENCLAW_TOKENPILOT_HOST_BINDING);
}
