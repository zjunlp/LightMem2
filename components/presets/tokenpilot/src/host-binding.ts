import { registerStabilizerProductSurfaceContribution } from "@lightmem2/stabilizer";
import {
  TOKENPILOT_FEATURE_MODULE_IDS,
  TOKENPILOT_PRESET_ID,
  TOKENPILOT_PRESET_VERSION,
  type TokenPilotFeatureModule,
} from "./preset-contract.js";

export type TokenPilotHostBinding = {
  hostId: string;
  presetId: typeof TOKENPILOT_PRESET_ID;
  presetVersion: typeof TOKENPILOT_PRESET_VERSION;
  supportedFeatures: readonly TokenPilotFeatureModule[];
};

export function createTokenPilotHostBinding(params: {
  hostId: string;
  supportedFeatures: readonly TokenPilotFeatureModule[];
}): TokenPilotHostBinding {
  const hostId = params.hostId.trim();
  if (!hostId) {
    throw new Error("TokenPilot host binding requires a non-empty hostId");
  }
  const supported = new Set<TokenPilotFeatureModule>();
  for (const feature of params.supportedFeatures) {
    if (!TOKENPILOT_FEATURE_MODULE_IDS.includes(feature)) {
      throw new Error(`TokenPilot host binding '${hostId}' declares unknown feature '${feature}'`);
    }
    supported.add(feature);
  }
  return Object.freeze({
    hostId,
    presetId: TOKENPILOT_PRESET_ID,
    presetVersion: TOKENPILOT_PRESET_VERSION,
    supportedFeatures: Object.freeze([...supported]),
  });
}

export function initializeTokenPilotPreset(binding: TokenPilotHostBinding): void {
  if (binding.presetId !== TOKENPILOT_PRESET_ID || binding.presetVersion !== TOKENPILOT_PRESET_VERSION) {
    throw new Error(
      `Unsupported TokenPilot preset binding '${binding.presetId}@${binding.presetVersion}' for host '${binding.hostId}'`,
    );
  }
  if (binding.supportedFeatures.includes("stabilizer")) {
    registerStabilizerProductSurfaceContribution();
  }
}
