import type { RuntimeTurnContext } from "@tokenpilot/kernel";

export type ProxyReductionBinding =
  | {
    segmentId: string;
    itemIndex: number;
    field: "arguments" | "output" | "result";
    beforeLen: number;
    toolName?: string;
    dataPath?: string;
  }
  | {
    segmentId: string;
    itemIndex: number;
    field: "content";
    blockIndex?: number;
    blockKey?: "text" | "content";
    beforeLen: number;
    toolName?: string;
    dataPath?: string;
  };

export type ReductionContextPassToggles = {
  readStateCompaction?: boolean;
  toolPayloadTrim?: boolean;
  htmlSlimming?: boolean;
  execOutputTruncation?: boolean;
  agentsStartupOptimization?: boolean;
};

export type BuildLayeredReductionContextResult = {
  turnCtx: RuntimeTurnContext;
  bindings: ProxyReductionBinding[];
  stats: {
    inputItems: number;
    toolLikeItems: number;
    persistedSkippedItems: number;
    candidateBlocks: number;
    overThresholdBlocks: number;
    instructionCount: number;
    enableToolPayloadTrim?: boolean;
    passToggles?: Record<string, boolean>;
  };
};
