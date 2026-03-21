import type { RuntimeModule } from "@ecoclaw/kernel";

export type RetrievalModuleConfig = {
  enabled?: boolean;
  topK?: number;
  implementation?: string;
  provider?: string;
  options?: Record<string, unknown>;
};

export function createRetrievalModule(cfg: RetrievalModuleConfig = {}): RuntimeModule {
  const enabled = cfg.enabled ?? false;
  const topK = cfg.topK ?? 4;
  const implementation = cfg.implementation ?? "qmd";
  const provider = cfg.provider ?? implementation;
  const options = cfg.options ?? {};

  return {
    name: "module-retrieval",
    async beforeBuild(ctx) {
      if (!enabled) return ctx;
      return {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          retrieval: {
            implementation,
            provider,
            topK,
            options,
          },
        },
      };
    },
  };
}

// Backward-compatible alias: older code can still call the previous function.
export function createRetrievalQmdModule(cfg: RetrievalModuleConfig = {}): RuntimeModule {
  return createRetrievalModule({
    implementation: "qmd",
    provider: "qmd",
    ...cfg,
  });
}
