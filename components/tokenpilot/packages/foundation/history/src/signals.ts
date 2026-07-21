import type { HistoryBlock, HistorySignal } from "./types.js";

export type RuleSignalConfig = {
  largeBlockChars?: number;
};

const DEFAULT_LARGE_BLOCK_CHARS = 4000;

function isSuccessfulWriteLike(text: string): boolean {
  const lowered = text.toLowerCase();
  if (/successfully (wrote|updated|edited|applied)/i.test(text)) return true;
  if (lowered.includes('"status":"success"') || lowered.includes('"status": "success"')) return true;
  if (lowered.includes("'status': 'success'")) return true;
  return false;
}

export function collectRuleSignals(
  blocks: HistoryBlock[],
  config: RuleSignalConfig = {},
): HistorySignal[] {
  const largeBlockChars = Math.max(256, config.largeBlockChars ?? DEFAULT_LARGE_BLOCK_CHARS);
  const out: HistorySignal[] = [];
  const lastReadByDataKey = new Map<string, HistoryBlock>();

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];

    if (block.charCount >= largeBlockChars) {
      out.push({
        type: "LARGE_BLOCK",
        blockId: block.blockId,
        confidence: 0.9,
        rationale: `block chars=${block.charCount} >= ${largeBlockChars}`,
      });
    }

    if (i >= Math.max(0, blocks.length - 3)) {
      out.push({
        type: "RECENT_BLOCK",
        blockId: block.blockId,
        confidence: 0.6,
        rationale: "block is inside recent window",
      });
    }

    if (block.blockType === "tool_result" && block.dataKey) {
      const previous = lastReadByDataKey.get(block.dataKey);
      if (previous && previous.text === block.text) {
        out.push({
          type: "REPEATED_READ",
          blockId: block.blockId,
          confidence: 0.95,
          rationale: `same data_key re-read: ${block.dataKey}`,
          metadata: { previousBlockId: previous.blockId, dataKey: block.dataKey },
        });
      }
      lastReadByDataKey.set(block.dataKey, block);

      if (/\b(error|enoent|not found|failed)\b/i.test(block.text)) {
        out.push({
          type: "FAILED_TOOL_PATH",
          blockId: block.blockId,
          confidence: 0.9,
          rationale: "tool result contains error-like pattern",
        });
      }
    }

    if (block.blockType === "write_result" && isSuccessfulWriteLike(block.text)) {
      for (let j = 0; j < i; j += 1) {
        const prev = blocks[j];
        if (prev.blockType !== "tool_result") continue;
        out.push({
          type: "READ_CONSUMED_BY_WRITE",
          blockId: prev.blockId,
          confidence: 0.8,
          rationale: `preceding tool_result is likely consumed by later write_result ${block.blockId}`,
          metadata: { consumedByBlockId: block.blockId },
        });
      }
    }
  }

  return out;
}
