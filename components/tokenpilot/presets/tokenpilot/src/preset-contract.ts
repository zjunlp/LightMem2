export const TOKENPILOT_PRESET_ID = "tokenpilot" as const;
export const TOKENPILOT_PRESET_VERSION = "1" as const;

export const TOKENPILOT_FEATURE_MODULE_IDS = [
  "stabilizer",
  "reduction",
  "eviction",
] as const;

export type TokenPilotFeatureModule = (typeof TOKENPILOT_FEATURE_MODULE_IDS)[number];
export type TokenPilotModuleEnablement = Record<TokenPilotFeatureModule, boolean>;

export const TOKENPILOT_REQUEST_MODULE_IDS = {
  stabilizer: "stabilizer",
  memoryInjection: "memory-injection",
  stabilizerTrace: "stabilizer-trace",
  reductionSnapshot: "reduction-snapshot",
  lifecyclePlanning: "lifecycle-planning",
  reduction: "reduction",
} as const;

export const TOKENPILOT_REQUEST_MODULE_ORDER = [
  TOKENPILOT_REQUEST_MODULE_IDS.stabilizer,
  TOKENPILOT_REQUEST_MODULE_IDS.memoryInjection,
  TOKENPILOT_REQUEST_MODULE_IDS.stabilizerTrace,
  TOKENPILOT_REQUEST_MODULE_IDS.reductionSnapshot,
  TOKENPILOT_REQUEST_MODULE_IDS.lifecyclePlanning,
  TOKENPILOT_REQUEST_MODULE_IDS.reduction,
] as const;

export const TOKENPILOT_HISTORY_MODULE_IDS = {
  canonicalSync: "canonical-sync",
  eviction: "eviction",
  memoryConsumer: "memory-consumer",
  canonicalPersistence: "canonical-persistence",
} as const;

export const TOKENPILOT_HISTORY_MODULE_ORDER = [
  TOKENPILOT_HISTORY_MODULE_IDS.canonicalSync,
  TOKENPILOT_HISTORY_MODULE_IDS.eviction,
  TOKENPILOT_HISTORY_MODULE_IDS.memoryConsumer,
  TOKENPILOT_HISTORY_MODULE_IDS.canonicalPersistence,
] as const;

export type TokenPilotModuleCombination = {
  id:
    | "none"
    | "stabilizer-only"
    | "reduction-only"
    | "eviction-only"
    | "stabilizer-reduction"
    | "stabilizer-eviction"
    | "reduction-eviction"
    | "all";
  enablement: TokenPilotModuleEnablement;
};

export const TOKENPILOT_MODULE_COMBINATIONS: readonly TokenPilotModuleCombination[] = [
  { id: "none", enablement: { stabilizer: false, reduction: false, eviction: false } },
  { id: "stabilizer-only", enablement: { stabilizer: true, reduction: false, eviction: false } },
  { id: "reduction-only", enablement: { stabilizer: false, reduction: true, eviction: false } },
  { id: "eviction-only", enablement: { stabilizer: false, reduction: false, eviction: true } },
  { id: "stabilizer-reduction", enablement: { stabilizer: true, reduction: true, eviction: false } },
  { id: "stabilizer-eviction", enablement: { stabilizer: true, reduction: false, eviction: true } },
  { id: "reduction-eviction", enablement: { stabilizer: false, reduction: true, eviction: true } },
  { id: "all", enablement: { stabilizer: true, reduction: true, eviction: true } },
] as const;

export function buildTokenPilotCombinationConfig(enablement: TokenPilotModuleEnablement) {
  return {
    modules: {
      stabilizer: enablement.stabilizer,
      policy: enablement.eviction,
      reduction: enablement.reduction,
      eviction: enablement.eviction,
    },
    eviction: {
      enabled: enablement.eviction,
    },
  };
}
