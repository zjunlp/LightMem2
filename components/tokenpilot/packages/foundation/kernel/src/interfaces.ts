import type { RuntimeTurnContext, RuntimeTurnResult } from "./types.js";

export type RuntimeModuleRuntime = {
  callModel(
    ctx: RuntimeTurnContext,
    options?: {
      annotatePrompt?: boolean;
      normalizeUsage?: boolean;
    },
  ): Promise<RuntimeTurnResult>;
};

export type RuntimeModule = {
  name: string;
  beforeBuild?(ctx: RuntimeTurnContext, runtime: RuntimeModuleRuntime): Promise<RuntimeTurnContext>;
  beforeCall?(ctx: RuntimeTurnContext, runtime: RuntimeModuleRuntime): Promise<RuntimeTurnContext>;
  afterCall?(
    ctx: RuntimeTurnContext,
    result: RuntimeTurnResult,
    runtime: RuntimeModuleRuntime,
  ): Promise<RuntimeTurnResult>;
};

