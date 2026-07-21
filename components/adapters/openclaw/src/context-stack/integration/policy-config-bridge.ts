import type { RuntimeModule, RuntimeModuleRuntime, RuntimeTurnContext } from "@lightmem2/kernel";
import type { PolicyModuleConfig } from "@tokenpilot/decision";
import { applyPolicyMonitors } from "./runtime-policy-monitors.js";
import { asRecord, type NormalizedPluginRuntimeConfig, type PluginLogger } from "./config-types.js";
import type { UpstreamConfig } from "./upstream-types.js";

const NULL_RUNTIME: RuntimeModuleRuntime = {
  async callModel() {
    throw new Error("callModel is unavailable during plugin-side before_call optimization");
  },
};

export function buildPolicyModuleConfigFromPluginConfig(
  cfg: NormalizedPluginRuntimeConfig,
  upstream?: UpstreamConfig | null,
): PolicyModuleConfig {
  const fallbackEstimatorModel = upstream?.models?.[0]?.id;
  const estimatorBaseUrl = cfg.taskStateEstimator.baseUrl ?? upstream?.baseUrl;
  const estimatorApiKey = cfg.taskStateEstimator.apiKey ?? upstream?.apiKey;
  const estimatorModel = cfg.taskStateEstimator.model ?? fallbackEstimatorModel;

  return {
    localityEnabled: true,
    stateDir: cfg.stateDir,
    reductionEnabled: false,
    reductionFormatSlimmingEnabled: false,
    reductionSemanticEnabled: false,
    evictionEnabled: cfg.moduleEnablement.eviction,
    evictionPolicy: cfg.eviction.policy,
    evictionMinBlockChars: cfg.eviction.minBlockChars,
    taskStateEstimator: cfg.taskStateEstimator.enabled
      ? {
          enabled: true,
          baseUrl: estimatorBaseUrl,
          apiKey: estimatorApiKey,
          model: estimatorModel,
          requestTimeoutMs: cfg.taskStateEstimator.requestTimeoutMs,
          batchTurns: cfg.taskStateEstimator.batchTurns,
          evictionLookaheadTurns: cfg.taskStateEstimator.evictionLookaheadTurns,
          completedSummaryMaxRawTurns: cfg.taskStateEstimator.completedSummaryMaxRawTurns,
          inputMode: cfg.taskStateEstimator.inputMode,
          lifecycleMode: cfg.taskStateEstimator.lifecycleMode,
          evidenceMode: cfg.taskStateEstimator.evidenceMode,
          evictionPromotionPolicy: cfg.taskStateEstimator.evictionPromotionPolicy,
          evictionPromotionHotTailSize: cfg.taskStateEstimator.evictionPromotionHotTailSize,
        }
      : { enabled: false },
    cacheHealthEnabled: false,
  };
}

export async function applyPolicyBeforeCall(
  turnCtx: RuntimeTurnContext,
  cfg: NormalizedPluginRuntimeConfig,
  logger: Required<PluginLogger>,
  modules: { policy?: RuntimeModule } | undefined,
): Promise<{ turnCtx: RuntimeTurnContext; policyChangedSegmentIds: string[] }> {
  let nextCtx = turnCtx;
  const bridgedReductionDecision = asRecord(asRecord(asRecord(nextCtx.metadata?.policy)?.decisions)?.reduction);

  if (modules?.policy?.beforeBuild) {
    nextCtx = await modules.policy.beforeBuild(nextCtx, NULL_RUNTIME);
    applyPolicyMonitors(nextCtx, logger, asRecord);
    if (bridgedReductionDecision) {
      const policy = asRecord(nextCtx.metadata?.policy) ?? {};
      const decisions = asRecord(policy.decisions) ?? {};
      nextCtx = {
        ...nextCtx,
        metadata: {
          ...(nextCtx.metadata ?? {}),
          policy: { ...policy, decisions: { ...decisions, reduction: bridgedReductionDecision } },
        },
      };
    }
  }

  return { turnCtx: nextCtx, policyChangedSegmentIds: [] };
}
