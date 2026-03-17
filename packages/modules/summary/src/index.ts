import type { RuntimeModule } from "@ecoclaw/kernel";

export type SummaryModuleConfig = {
  idleTriggerMinutes?: number;
};

export function createSummaryModule(cfg: SummaryModuleConfig = {}): RuntimeModule {
  const idleTriggerMinutes = cfg.idleTriggerMinutes ?? 50;

  return {
    name: "module-summary",
    async afterCall(_ctx, result) {
      return {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          summary: {
            idleTriggerMinutes,
            note: "summary scheduling hook point",
          },
        },
      };
    },
  };
}

