import type { RuntimeModule } from "@ecoclaw/kernel";

export type CompressionModuleConfig = {
  maxToolChars?: number;
  strategy?: "rule" | "llmlingua2";
};

export function createCompressionModule(cfg: CompressionModuleConfig = {}): RuntimeModule {
  const maxToolChars = cfg.maxToolChars ?? 1200;
  const strategy = cfg.strategy ?? "rule";

  return {
    name: "module-compression",
    async afterCall(_ctx, result) {
      const content = result.content.length > maxToolChars
        ? `${result.content.slice(0, maxToolChars)}\n...[compressed:${strategy}]`
        : result.content;
      return { ...result, content };
    },
  };
}

