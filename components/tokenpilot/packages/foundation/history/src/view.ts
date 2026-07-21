import type { RuntimeTurnContext } from "@tokenpilot/kernel";
import { buildHistoryBlocks } from "./chunking.js";
import { deriveHistoryLifecycle } from "./lifecycle.js";
import { scoreHistoryBlocks } from "./scoring.js";
import { collectRuleSignals, type RuleSignalConfig } from "./signals.js";
import type {
  HistoryBlock,
  HistoryChunkingConfig,
  HistoryLifecycleConfig,
  HistoryScoringConfig,
} from "./types.js";

export type HistoryViewConfig = {
  chunking?: HistoryChunkingConfig;
  signals?: RuleSignalConfig;
  lifecycle?: HistoryLifecycleConfig;
  scoring?: HistoryScoringConfig;
};

export type HistoryView = {
  blocks: HistoryBlock[];
  segmentToBlockId: Map<string, string>;
};

export function buildHistoryView(
  ctx: RuntimeTurnContext,
  config: HistoryViewConfig = {},
): HistoryView {
  const chunked = buildHistoryBlocks(ctx, config.chunking);
  const signals = collectRuleSignals(chunked.blocks, config.signals);
  const lifecycled = deriveHistoryLifecycle(chunked.blocks, signals, config.lifecycle);
  const scored = scoreHistoryBlocks(lifecycled.blocks, config.scoring);
  return {
    blocks: scored,
    segmentToBlockId: chunked.segmentToBlockId,
  };
}
