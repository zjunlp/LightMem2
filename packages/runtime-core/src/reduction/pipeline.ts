import type { RuntimeTurnContext, RuntimeTurnResult } from "@tokenpilot/kernel";
import { resolveReductionPass, execOutputTruncationBeforeCallPass } from "./registry.js";
import type {
  ReductionMetadata,
  ReductionModuleConfig,
  ReductionPhase,
  ReductionPassRegistry,
  ReductionPassSpec,
  ReductionReportEntry,
} from "./types.js";

export type RunReductionBeforeCallParams = {
  turnCtx: RuntimeTurnContext;
  passes: ReductionPassSpec[];
  registry?: ReductionPassRegistry;
};

export type RunReductionAfterCallParams = {
  turnCtx: RuntimeTurnContext;
  result: RuntimeTurnResult;
  passes: ReductionPassSpec[];
  registry?: ReductionPassRegistry;
};

const clonePass = (spec: ReductionPassSpec): ReductionPassSpec => ({
  ...spec,
  options: spec.options ? { ...spec.options } : undefined,
});

export function resolveReductionPasses(
  cfg: ReductionModuleConfig = {},
): ReductionPassSpec[] {
  if (Array.isArray(cfg.passes) && cfg.passes.length > 0) {
    return cfg.passes.map(clonePass);
  }

  const passOptions = cfg.passOptions ?? {};

  return [
    {
      id: "repeated_read_dedup",
      phase: "before_call",
      target: "context_segment",
      options: {
        enabled: true,
        ...(passOptions.repeated_read_dedup ?? {}),
      },
    },
    {
      id: "tool_payload_trim",
      phase: "before_call",
      target: "tool_payload",
      options: {
        maxChars: cfg.maxToolChars ?? 1200,
        noteLabel: cfg.strategy ?? "rule",
        ...(passOptions.tool_payload_trim ?? {}),
      },
    },
    {
      id: "html_slimming",
      phase: "before_call",
      target: "structured_payload",
      options: {
        enabled: true,
        ...(passOptions.html_slimming ?? {}),
      },
    },
    {
      id: "exec_output_truncation",
      phase: "before_call",
      target: "context_segment",
      options: {
        enabled: true,
        ...(passOptions.exec_output_truncation ?? {}),
      },
    },
    {
      id: "agents_startup_optimization",
      phase: "before_call",
      target: "context_segment",
      options: {
        enabled: true,
        ...(passOptions.agents_startup_optimization ?? {}),
      },
    },
    {
      id: "format_slimming",
      phase: "after_call",
      target: "result_content",
      options: {
        removeCodeFences: true,
        collapseBlankLines: true,
        trimTrailingSpaces: true,
        ...(passOptions.format_slimming ?? {}),
      },
    },
    {
      id: "format_cleaning",
      phase: "after_call",
      target: "result_content",
      options: {
        enabled: true,
        ...(passOptions.format_cleaning ?? {}),
      },
    },
    {
      id: "path_truncation",
      phase: "after_call",
      target: "result_content",
      options: {
        enabled: true,
        ...(passOptions.path_truncation ?? {}),
      },
    },
    {
      id: "image_downsample",
      phase: "after_call",
      target: "result_content",
      options: {
        enabled: true,
        ...(passOptions.image_downsample ?? {}),
      },
    },
    {
      id: "line_number_strip",
      phase: "after_call",
      target: "result_content",
      options: {
        enabled: true,
        ...(passOptions.line_number_strip ?? {}),
      },
    },
  ];
}

const totalSegmentChars = (ctx: RuntimeTurnContext): number =>
  ctx.segments.reduce((sum, segment) => sum + segment.text.length, 0);

const isPhaseMatch = (spec: ReductionPassSpec, phase: ReductionPhase): boolean =>
  (spec.phase ?? "before_call") === phase;

export function readReductionMetadata(metadata?: Record<string, unknown>): ReductionMetadata {
  const raw = metadata?.reduction;
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  return {
    beforeCall: Array.isArray(obj.beforeCall) ? (obj.beforeCall as ReductionReportEntry[]) : undefined,
    afterCall: Array.isArray(obj.afterCall) ? (obj.afterCall as ReductionReportEntry[]) : undefined,
  };
}

export async function runReductionBeforeCall(
  params: RunReductionBeforeCallParams,
): Promise<{ turnCtx: RuntimeTurnContext; report: ReductionReportEntry[] }> {
  const { turnCtx, passes, registry } = params;
  let currentCtx: RuntimeTurnContext = {
    ...turnCtx,
    segments: turnCtx.segments.map((segment) => ({ ...segment })),
  };
  const report: ReductionReportEntry[] = [];

  for (const rawSpec of passes) {
    const spec = clonePass(rawSpec);
    if (!isPhaseMatch(spec, "before_call")) continue;
    if (spec.enabled === false) {
      report.push({
        id: spec.id,
        phase: "before_call",
        target: spec.target ?? "result_content",
        changed: false,
        skippedReason: "disabled",
        beforeChars: totalSegmentChars(currentCtx),
        afterChars: totalSegmentChars(currentCtx),
      });
      continue;
    }

    // Special handler for exec_output_truncation beforeCall
    const handler = spec.id === "exec_output_truncation"
      ? execOutputTruncationBeforeCallPass
      : resolveReductionPass(spec.id, registry);

    if (!handler?.beforeCall) {
      report.push({
        id: spec.id,
        phase: "before_call",
        target: spec.target ?? "result_content",
        changed: false,
        skippedReason: handler ? "no_before_call_handler" : "unknown_pass",
        beforeChars: totalSegmentChars(currentCtx),
        afterChars: totalSegmentChars(currentCtx),
      });
      continue;
    }

    const beforeChars = totalSegmentChars(currentCtx);
    const outcome = await handler.beforeCall({
      turnCtx: currentCtx,
      spec,
    });

    if (outcome.turnCtx) {
      currentCtx = outcome.metadata
        ? {
            ...outcome.turnCtx,
            metadata: {
              ...(outcome.turnCtx.metadata ?? {}),
              ...outcome.metadata,
            },
          }
        : outcome.turnCtx;
    } else if (outcome.metadata) {
      currentCtx = {
        ...currentCtx,
        metadata: {
          ...(currentCtx.metadata ?? {}),
          ...outcome.metadata,
        },
      };
    }

    report.push({
      id: spec.id,
      phase: "before_call",
      target: spec.target ?? "result_content",
      changed: outcome.changed,
      note: outcome.note,
      skippedReason: outcome.skippedReason,
      beforeChars,
      afterChars: totalSegmentChars(currentCtx),
      touchedSegmentIds: outcome.touchedSegmentIds,
    });
  }

  return { turnCtx: currentCtx, report };
}

export async function runReductionAfterCall(
  params: RunReductionAfterCallParams,
): Promise<{ result: RuntimeTurnResult; report: ReductionReportEntry[] }> {
  const { turnCtx, result, passes, registry } = params;
  let currentResult: RuntimeTurnResult = { ...result };
  const report: ReductionReportEntry[] = [];

  for (const rawSpec of passes) {
    const spec = clonePass(rawSpec);
    if (!isPhaseMatch(spec, "after_call")) continue;
    if (spec.enabled === false) {
      report.push({
        id: spec.id,
        phase: "after_call",
        target: spec.target ?? "result_content",
        changed: false,
        skippedReason: "disabled",
        beforeChars: currentResult.content.length,
        afterChars: currentResult.content.length,
      });
      continue;
    }

    const handler = resolveReductionPass(spec.id, registry);
    if (!handler?.afterCall) {
      report.push({
        id: spec.id,
        phase: "after_call",
        target: spec.target ?? "result_content",
        changed: false,
        skippedReason: handler ? "no_after_call_handler" : "unknown_pass",
        beforeChars: currentResult.content.length,
        afterChars: currentResult.content.length,
      });
      continue;
    }

    const beforeChars = currentResult.content.length;
    const outcome = await handler.afterCall({
      turnCtx,
      originalResult: result,
      currentResult,
      spec,
    });

    if (outcome.result) {
      currentResult = outcome.metadata
        ? {
            ...outcome.result,
            metadata: {
              ...(outcome.result.metadata ?? {}),
              ...outcome.metadata,
            },
          }
        : outcome.result;
    } else if (outcome.metadata) {
      currentResult = {
        ...currentResult,
        metadata: {
          ...(currentResult.metadata ?? {}),
          ...outcome.metadata,
        },
      };
    }

    report.push({
      id: spec.id,
      phase: "after_call",
      target: spec.target ?? "result_content",
      changed: outcome.changed,
      note: outcome.note,
      skippedReason: outcome.skippedReason,
      beforeChars,
      afterChars: currentResult.content.length,
    });
  }

  return { result: currentResult, report };
}
