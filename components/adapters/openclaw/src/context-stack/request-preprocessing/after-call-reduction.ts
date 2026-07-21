/* eslint-disable @typescript-eslint/no-explicit-any */
import { runReductionAfterCall, resolveReductionPasses } from "@tokenpilot/reduction";
import type { RuntimeTurnResult } from "@tokenpilot/kernel";
import { extractProxyResponseText, isSseContentType, patchProxyResponseText } from "./after-call-response-text.js";
import {
  ensureCompletedResponseTextFromSse,
  patchSseEventForReducedText,
  resolveCompletedResponseFromSse,
  rewriteSseJsonEvents,
} from "./after-call-sse.js";

export type AfterCallPassToggles = {
  readStateCompaction?: boolean;
  toolPayloadTrim?: boolean;
  htmlSlimming?: boolean;
  execOutputTruncation?: boolean;
  agentsStartupOptimization?: boolean;
  formatSlimming?: boolean;
  formatCleaning?: boolean;
  pathTruncation?: boolean;
  imageDownsample?: boolean;
  lineNumberStrip?: boolean;
};

export type ProxyAfterCallReductionResult = {
  changed: boolean;
  savedChars: number;
  passCount: number;
  skippedReason?: string;
  report?: Array<any>;
  mode?: "json" | "sse";
  patchedEvents?: number;
};

type AfterCallHelpers = {
  buildLayeredReductionContext: (
    payload: any,
    triggerMinChars: number,
    sessionId: string,
    passToggles?: AfterCallPassToggles,
    passOptions?: Record<string, Record<string, unknown>>,
  ) => { turnCtx: any };
  isReductionPassEnabled: (passId: string, passToggles?: AfterCallPassToggles) => boolean;
};

export async function applyLayeredReductionAfterCall(
  requestPayload: any,
  parsedResponse: any,
  maxToolChars: number,
  triggerMinChars: number,
  sessionId: string,
  passToggles: AfterCallPassToggles | undefined,
  passOptions: Record<string, Record<string, unknown>> | undefined,
  helpers: AfterCallHelpers,
): Promise<ProxyAfterCallReductionResult> {
  const responseText = extractProxyResponseText(parsedResponse);
  if (!responseText) {
    return { changed: false, savedChars: 0, passCount: 0, skippedReason: "empty_response_text" };
  }

  const { turnCtx } = helpers.buildLayeredReductionContext(
    requestPayload,
    triggerMinChars,
    sessionId,
    passToggles,
    passOptions,
  );
  const passes = resolveReductionPasses({ maxToolChars, passOptions }).filter(
    (p) => p.phase === "after_call" && helpers.isReductionPassEnabled(p.id, passToggles),
  );
  if (passes.length === 0) {
    return { changed: false, savedChars: 0, passCount: 0, skippedReason: "no_after_call_passes" };
  }

  const result: RuntimeTurnResult = {
    content: responseText,
    metadata: {},
  };
  const { result: reducedResult, report: afterReport } = await runReductionAfterCall({
    turnCtx,
    result,
    passes,
  });

  const nextText = String(reducedResult?.content ?? "");
  if (!nextText || nextText === responseText) {
    return {
      changed: false,
      savedChars: 0,
      passCount: passes.length,
      skippedReason: "pipeline_no_effect",
      report: afterReport,
    };
  }

  const patched = patchProxyResponseText(parsedResponse, nextText);
  if (!patched) {
    return {
      changed: false,
      savedChars: 0,
      passCount: passes.length,
      skippedReason: "response_patch_no_effect",
      report: afterReport,
    };
  }
  return {
    changed: true,
    savedChars: Math.max(0, responseText.length - nextText.length),
    passCount: passes.length,
    report: afterReport,
  };
}

export async function applyLayeredReductionAfterCallToSse(
  requestPayload: any,
  rawSse: string,
  maxToolChars: number,
  triggerMinChars: number,
  sessionId: string,
  passToggles: AfterCallPassToggles | undefined,
  passOptions: Record<string, Record<string, unknown>> | undefined,
  helpers: AfterCallHelpers,
): Promise<{ text: string; reduction: ProxyAfterCallReductionResult }> {
  const { completedResponse, probeChangedEvents } = resolveCompletedResponseFromSse(rawSse);
  if (!completedResponse) {
    return {
      text: rawSse,
      reduction: {
        changed: false,
        savedChars: 0,
        passCount: 0,
        skippedReason: "sse_missing_response_completed",
        mode: "sse",
        patchedEvents: probeChangedEvents,
      },
    };
  }

  ensureCompletedResponseTextFromSse(rawSse, completedResponse);

  const afterCallReduction = await applyLayeredReductionAfterCall(
    requestPayload,
    completedResponse,
    maxToolChars,
    triggerMinChars,
    sessionId,
    passToggles,
    passOptions,
    helpers,
  );
  if (!afterCallReduction.changed) {
    return { text: rawSse, reduction: { ...afterCallReduction, mode: "sse" } };
  }
  const nextText = extractProxyResponseText(completedResponse);
  if (!nextText) {
    return {
      text: rawSse,
      reduction: {
        ...afterCallReduction,
        changed: false,
        skippedReason: "sse_reduced_text_empty",
        mode: "sse",
      },
    };
  }

  const rewritten = rewriteSseJsonEvents(rawSse, (event) => patchSseEventForReducedText(event, nextText));
  if (rewritten.changedEvents <= 0) {
    return {
      text: rawSse,
      reduction: {
        ...afterCallReduction,
        changed: false,
        skippedReason: "sse_patch_no_effect",
        mode: "sse",
        patchedEvents: 0,
      },
    };
  }
  return {
    text: rewritten.text,
    reduction: { ...afterCallReduction, mode: "sse", patchedEvents: rewritten.changedEvents },
  };
}
