/* eslint-disable @typescript-eslint/no-explicit-any */
import { detectToolPayloadKind, type BuildLayeredReductionContextDeps } from "./reduction-context-shared.js";

export function createReductionInstructionCollector(params: {
  passToggles?: {
    readStateCompaction?: boolean;
    toolPayloadTrim?: boolean;
    htmlSlimming?: boolean;
    execOutputTruncation?: boolean;
  };
  passOptions?: Record<string, Record<string, unknown>>;
  deps: BuildLayeredReductionContextDeps;
}) {
  const { passToggles, passOptions, deps } = params;
  const reductionInstructions: Array<{
    strategy: string;
    segmentIds: string[];
    parameters?: Record<string, unknown>;
  }> = [];
  const readByKey = new Map<string, string[]>();
  const enableReadStateCompaction = passToggles?.readStateCompaction ?? true;
  const enableToolPayloadTrim = passToggles?.toolPayloadTrim ?? true;
  const enableHtmlSlimming = passToggles?.htmlSlimming ?? true;
  const enableExecOutputTruncation = passToggles?.execOutputTruncation ?? true;
  const execOutputOptions = passOptions?.exec_output_truncation ?? {};
  const execOutputToolThresholds =
    execOutputOptions.toolThresholds && typeof execOutputOptions.toolThresholds === "object"
      ? execOutputOptions.toolThresholds as Record<string, number>
      : undefined;
  const EXEC_OUTPUT_DEFAULT_THRESHOLD_CHARS = 50_000;
  const EXEC_OUTPUT_TOOL_THRESHOLDS: Record<string, number> = {
    bash: 30_000,
    shell: 30_000,
    powershell: 30_000,
    grep: 20_000,
    rg: 20_000,
    read: Number.POSITIVE_INFINITY,
    file_read: Number.POSITIVE_INFINITY,
    mcp_auth: 10_000,
    glob: 100_000,
    write: 100_000,
    edit: 100_000,
    file_write: 100_000,
    file_edit: 100_000,
    web_fetch: 100_000,
    web_search: 100_000,
    agent: 100_000,
    task: 100_000,
  };

  let candidateBlocks = 0;
  let overThresholdBlocks = 0;

  const getExecOutputThreshold = (rawToolName: string): number => {
    const normalizedToolName = rawToolName.trim().toLowerCase();
    if (!normalizedToolName) return EXEC_OUTPUT_DEFAULT_THRESHOLD_CHARS;
    if (
      execOutputToolThresholds &&
      typeof execOutputToolThresholds[normalizedToolName] === "number" &&
      Number.isFinite(execOutputToolThresholds[normalizedToolName])
    ) {
      return execOutputToolThresholds[normalizedToolName] as number;
    }
    return EXEC_OUTPUT_TOOL_THRESHOLDS[normalizedToolName] ?? EXEC_OUTPUT_DEFAULT_THRESHOLD_CHARS;
  };

  const addReductionInstructions = (segmentId: string, text: string, toolName: string): void => {
    candidateBlocks += 1;
    const execOutputThreshold = getExecOutputThreshold(toolName);
    const overThreshold = text.length >= execOutputThreshold;
    if (overThreshold) {
      overThresholdBlocks += 1;
    }
    const payloadKind = detectToolPayloadKind(text, deps) ?? "stdout";
    if (enableToolPayloadTrim) {
      reductionInstructions.push({
        strategy: "tool_payload_trim",
        segmentIds: [segmentId],
        parameters: { payloadKind },
      });
      if (enableHtmlSlimming) {
        reductionInstructions.push({
          strategy: "html_slimming",
          segmentIds: [segmentId],
        });
      }
    }
    if (overThreshold && enableExecOutputTruncation) {
      reductionInstructions.push({
        strategy: "exec_output_truncation",
        segmentIds: [segmentId],
        parameters: {
          toolName: toolName || undefined,
          thresholdChars: Number.isFinite(execOutputThreshold) ? execOutputThreshold : undefined,
        },
      });
    }
  };

  const recordReadSegment = (toolName: string, dataPath: string, readKey: string, fieldName?: string): void => {
    if (toolName !== "read" || !dataPath || !readKey || fieldName === "arguments") return;
    const bucket = readByKey.get(readKey) ?? [];
    bucket.push(fieldName ? fieldName : dataPath);
    readByKey.set(readKey, bucket);
  };

  const recordReadSegmentId = (
    toolName: string,
    dataPath: string,
    readKey: string,
    segmentId: string,
    fieldName?: string,
  ): void => {
    if (toolName !== "read" || !dataPath || !readKey || fieldName === "arguments") return;
    const bucket = readByKey.get(readKey) ?? [];
    bucket.push(segmentId);
    readByKey.set(readKey, bucket);
  };

  const finalizeReadStateInstructions = (): void => {
    if (!enableReadStateCompaction) return;
    for (const segmentIds of readByKey.values()) {
      if (segmentIds.length < 2) continue;
      reductionInstructions.push({
        strategy: "read_state_compaction",
        segmentIds: [...segmentIds],
      });
    }
  };

  return {
    reductionInstructions,
    addReductionInstructions,
    recordReadSegment,
    recordReadSegmentId,
    finalizeReadStateInstructions,
    stats: {
      get candidateBlocks() {
        return candidateBlocks;
      },
      get overThresholdBlocks() {
        return overThresholdBlocks;
      },
      get enableToolPayloadTrim() {
        return enableToolPayloadTrim;
      },
      passToggles: {
        readStateCompaction: enableReadStateCompaction,
        toolPayloadTrim: enableToolPayloadTrim,
        htmlSlimming: enableHtmlSlimming,
        execOutputTruncation: enableExecOutputTruncation,
      },
    },
  };
}
