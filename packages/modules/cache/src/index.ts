import type { RuntimeModule } from "@ecoclaw/kernel";

export type CacheModuleConfig = {
  minPrefixChars?: number;
  profileVersionTag?: string;
};

export function createCacheModule(cfg: CacheModuleConfig = {}): RuntimeModule {
  const minPrefixChars = cfg.minPrefixChars ?? 500;
  const profileVersionTag = cfg.profileVersionTag ?? "v1";

  return {
    name: "module-cache",
    async beforeBuild(ctx) {
      const stable = ctx.segments.filter((s) => s.kind === "stable").map((s) => s.text).join("\n");
      const cacheEligible = stable.length >= minPrefixChars;
      return {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          cache: {
            eligible: cacheEligible,
            profileVersionTag,
          },
        },
      };
    },
  };
}

