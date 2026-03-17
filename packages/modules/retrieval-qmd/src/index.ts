import type { RuntimeModule } from "@ecoclaw/kernel";

export type RetrievalModuleConfig = {
  enabled?: boolean;
  topK?: number;
};

export function createRetrievalQmdModule(cfg: RetrievalModuleConfig = {}): RuntimeModule {
  const enabled = cfg.enabled ?? false;
  const topK = cfg.topK ?? 4;

  return {
    name: "module-retrieval-qmd",
    async beforeBuild(ctx) {
      if (!enabled) return ctx;
      return {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          retrieval: { provider: "qmd", topK },
        },
      };
    },
  };
}

