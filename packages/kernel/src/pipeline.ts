import type {
  MetricsSink,
  ModuleScheduleDecision,
  ModuleScheduler,
  ProviderAdapter,
  RuntimeModule,
} from "./interfaces.js";
import { resolveApiFamily } from "./api-family.js";
import type { RuntimeTurnContext, RuntimeTurnResult, RuntimeTurnTraceStep } from "./types.js";

export type RuntimePipelineConfig = {
  modules: RuntimeModule[];
  adapters: Record<string, ProviderAdapter>;
  metrics?: MetricsSink;
  moduleScheduler?: ModuleScheduler;
};

export class RuntimePipeline {
  constructor(private readonly cfg: RuntimePipelineConfig) {}

  async run(ctx: RuntimeTurnContext, invokeModel: (ctx: RuntimeTurnContext) => Promise<RuntimeTurnResult>) {
    const moduleSteps: RuntimeTurnTraceStep[] = [];
    const seededCtx: RuntimeTurnContext = {
      ...ctx,
      apiFamily: resolveApiFamily(ctx),
    };
    const defaultSchedule: ModuleScheduleDecision = {
      modules: this.cfg.modules,
      scheduleId: "static-all",
      reason: "pipeline-default-order",
    };
    const schedule = this.cfg.moduleScheduler
      ? await this.cfg.moduleScheduler.selectModules(seededCtx, this.cfg.modules)
      : defaultSchedule;
    const activeModules = schedule.modules;

    const pushStep = (
      stage: RuntimeTurnTraceStep["stage"],
      module: string,
      context: RuntimeTurnContext,
      responseChars?: number,
    ) => {
      moduleSteps.push({
        stage,
        module,
        promptChars: context.prompt.length,
        segmentCount: context.segments.length,
        responseChars,
        timestamp: new Date().toISOString(),
      });
    };

    let current = seededCtx;
    for (const mod of activeModules) {
      if (mod.beforeBuild) {
        current = await mod.beforeBuild(current);
        pushStep("beforeBuild", mod.name, current);
      }
    }

    const adapter = this.cfg.adapters[current.provider];
    if (adapter) {
      current = await adapter.annotatePrompt(current);
      pushStep("annotatePrompt", adapter.provider, current);
    }

    for (const mod of activeModules) {
      if (mod.beforeCall) {
        current = await mod.beforeCall(current);
        pushStep("beforeCall", mod.name, current);
      }
    }

    const requestSegments = current.segments.map((s) => ({
      id: s.id,
      kind: s.kind,
      priority: s.priority,
      source: s.source,
      text: s.text,
    }));
    const renderedPromptText = requestSegments
      .map((s) => `[${s.kind}|p${s.priority}|${s.id}]${s.source ? `(${s.source})` : ""}\n${s.text}`)
      .join("\n\n");

    let result = await invokeModel(current);
    const usageRaw = result.usage?.providerRaw;

    for (const mod of [...activeModules].reverse()) {
      if (mod.afterCall) {
        result = await mod.afterCall(current, result);
        pushStep("afterCall", mod.name, current, result.content.length);
      }
    }

    if (adapter && usageRaw) {
      result.usage = adapter.normalizeUsage(usageRaw);
    }

    result.metadata = {
      ...(result.metadata ?? {}),
      ecoclawTrace: {
        initialContext: seededCtx,
        finalContext: current,
        moduleSteps,
        requestDetail: {
          renderedPromptText,
          segments: requestSegments,
          metadata: (current.metadata ?? {}) as Record<string, unknown>,
        },
        scheduling: {
          scheduler: this.cfg.moduleScheduler?.name,
          scheduleId: schedule.scheduleId,
          reason: schedule.reason,
          metadata: schedule.metadata,
          availableModules: this.cfg.modules.map((m) => m.name),
          activeModules: activeModules.map((m) => m.name),
        },
        usageRaw,
        usageNormalized: result.usage,
        responsePreview: result.content,
      },
    };

    await this.cfg.metrics?.emit("turn.completed", {
      sessionId: current.sessionId,
      provider: current.provider,
      model: current.model,
      apiFamily: current.apiFamily ?? resolveApiFamily(current),
      usage: result.usage ?? {},
    });

    return result;
  }
}
