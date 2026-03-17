import type { RuntimeModule } from "@ecoclaw/kernel";

export type TaskRouterConfig = {
  enabled?: boolean;
  smallTaskTokenBudget?: number;
};

export function createTaskRouterModule(cfg: TaskRouterConfig = {}): RuntimeModule {
  const enabled = cfg.enabled ?? false;
  const smallTaskTokenBudget = cfg.smallTaskTokenBudget ?? 2000;

  return {
    name: "module-task-router",
    async beforeCall(ctx) {
      if (!enabled) return ctx;
      return {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          taskRouter: {
            decision: "placeholder",
            smallTaskTokenBudget,
          },
        },
      };
    },
  };
}

