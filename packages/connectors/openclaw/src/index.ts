import { RuntimePipeline, type RuntimeModule } from "@ecoclaw/kernel";

export type OpenClawConnectorConfig = {
  modules: RuntimeModule[];
  adapters: Record<string, any>;
};

export function createOpenClawConnector(cfg: OpenClawConnectorConfig) {
  const pipeline = new RuntimePipeline({ modules: cfg.modules, adapters: cfg.adapters });

  return {
    // Placeholder: wire these to OpenClaw plugin hooks.
    async onBeforePromptBuild(ctx: any) {
      return ctx;
    },
    async onLlmCall(turnCtx: any, invokeModel: (ctx: any) => Promise<any>) {
      return pipeline.run(turnCtx, invokeModel);
    },
  };
}

