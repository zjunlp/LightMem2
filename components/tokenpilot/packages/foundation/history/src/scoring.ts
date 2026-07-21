import type { HistoryBlock, HistoryScoringConfig } from "./types.js";

const DEFAULT_RECENT_WINDOW_SIZE = 3;
const DEFAULT_LARGE_BLOCK_CHARS = 4000;

export function scoreHistoryBlocks(
  blocks: HistoryBlock[],
  config: HistoryScoringConfig = {},
): HistoryBlock[] {
  const recentWindowSize = Math.max(1, config.recentWindowSize ?? DEFAULT_RECENT_WINDOW_SIZE);
  const largeBlockChars = Math.max(256, config.largeBlockChars ?? DEFAULT_LARGE_BLOCK_CHARS);

  return blocks.map((block, index) => {
    let localityScore = 0;
    let importanceScore = 0;

    if (index >= Math.max(0, blocks.length - recentWindowSize)) localityScore += 0.5;
    if (block.blockType === "tool_result") localityScore += 0.2;
    if (block.lifecycleState === "COMPACTABLE") localityScore -= 0.2;
    if (block.lifecycleState === "COMPACTED") localityScore -= 0.35;
    if (block.lifecycleState === "EVICTABLE") localityScore -= 0.5;
    if (block.blockType === "system_context") importanceScore += 0.9;
    if (block.blockType === "summary_seed") importanceScore += 0.8;
    if (block.blockType === "assistant_reply") importanceScore += 0.4;
    if (block.charCount >= largeBlockChars) importanceScore += 0.2;
    if (block.signalTypes?.includes("FAILED_TOOL_PATH")) importanceScore += 0.15;
    if (block.signalTypes?.includes("READ_CONSUMED_BY_WRITE")) localityScore -= 0.15;

    return {
      ...block,
      localityScore: Number(localityScore.toFixed(3)),
      importanceScore: Number(importanceScore.toFixed(3)),
    };
  });
}
