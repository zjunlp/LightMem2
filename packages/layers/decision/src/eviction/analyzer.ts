import type { HistoryBlock, SessionTaskRegistry } from "@ecoclaw/layer-history";
import type { EvictionBlock, EvictionDecision, EvictionPolicy } from "../types.js";

export type EvictionAnalyzerConfig = {
  enabled?: boolean;
  policy?: EvictionPolicy;
  minBlockChars?: number;
};

const DEFAULT_EVICTION_CONFIG: Required<EvictionAnalyzerConfig> = {
  enabled: false,
  policy: "noop",
  minBlockChars: 256,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function shouldSkipEviction(block: HistoryBlock): boolean {
  const eviction = asRecord(asRecord(block.metadata)?.eviction);
  return eviction?.skip === true;
}

function isTaskRegistryEvictionEligibleBlock(block: HistoryBlock, minBlockChars: number): boolean {
  if (block.charCount < minBlockChars) return false;
  if (shouldSkipEviction(block)) return false;
  const eviction = asRecord(asRecord(block.metadata)?.eviction);
  if (eviction?.archived === true) return false;
  return true;
}

function buildBlocksFromHistory(
  blocks: HistoryBlock[],
  minBlockChars: number,
): EvictionBlock[] {
  return blocks
    .filter((block) => isTaskRegistryEvictionEligibleBlock(block, minBlockChars))
    .map((block, index) => ({
      id: block.blockId,
      messageIds: [...block.segmentIds],
      blockType: block.blockType,
      chars: block.charCount,
      approxTokens: block.approxTokens,
      recencyRank: Math.max(0, blocks.length - index),
      frequency: block.signalTypes?.includes("REPEATED_READ") ? 2 : 1,
      regenerationCost:
        block.lifecycleState === "EVICTABLE"
          ? Math.max(1, Math.round(block.charCount / 8))
          : Math.max(1, Math.round(block.charCount / 16)),
      metadata: {
        ...(block.metadata ?? {}),
        lifecycleState: block.lifecycleState,
        toolName: block.toolName,
        dataKey: block.dataKey,
        signalTypes: block.signalTypes ?? [],
      },
    }));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function deriveBlockTaskIds(
  block: HistoryBlock,
  registry: SessionTaskRegistry,
): string[] {
  const direct = uniqueStrings(block.taskIds ?? []);
  if (direct.length > 0) return direct;
  const byTurns = uniqueStrings(
    (block.turnAbsIds ?? []).flatMap((turnAbsId) => registry.turnToTaskIds[turnAbsId] ?? []),
  );
  if (byTurns.length > 0) return byTurns;
  const byBlocks = uniqueStrings(
    registry.blockToTaskIds[block.blockId]
      ?? block.segmentIds.flatMap((segmentId) => registry.blockToTaskIds[segmentId] ?? []),
  );
  return byBlocks;
}

export function analyzeEvictionFromTaskRegistry(
  historyBlocks: HistoryBlock[],
  registry: SessionTaskRegistry,
  config: EvictionAnalyzerConfig = DEFAULT_EVICTION_CONFIG,
): EvictionDecision {
  const cfg = { ...DEFAULT_EVICTION_CONFIG, ...config };
  if (!cfg.enabled) {
    return {
      enabled: false,
      policy: cfg.policy,
      blocks: [],
      instructions: [],
      estimatedSavedChars: 0,
      notes: ["eviction_disabled"],
    };
  }

  const blocks = historyBlocks
    .filter((block) => isTaskRegistryEvictionEligibleBlock(block, cfg.minBlockChars))
    .map((block, index) => ({
      id: block.blockId,
      messageIds: [...block.segmentIds],
      blockType: block.blockType,
      chars: block.charCount,
      approxTokens: block.approxTokens,
      recencyRank: Math.max(0, historyBlocks.length - index),
      frequency: block.signalTypes?.includes("REPEATED_READ") ? 2 : 1,
      regenerationCost:
        block.lifecycleState === "EVICTABLE"
          ? Math.max(1, Math.round(block.charCount / 8))
          : Math.max(1, Math.round(block.charCount / 16)),
      metadata: {
        ...(block.metadata ?? {}),
        lifecycleState: block.lifecycleState,
        toolName: block.toolName,
        dataKey: block.dataKey,
        signalTypes: block.signalTypes ?? [],
      },
    }));
  const evictableTaskIds = new Set(registry.evictableTaskIds);
  const candidates = historyBlocks.filter((block) => {
    if (!isTaskRegistryEvictionEligibleBlock(block, cfg.minBlockChars)) return false;
    const matchedTaskIds = deriveBlockTaskIds(block, registry);
    return matchedTaskIds.some((taskId) => evictableTaskIds.has(taskId));
  });

  const instructions =
    cfg.policy === "noop"
      ? []
      : candidates.map((block, index) => {
          const matchedTaskIds = deriveBlockTaskIds(block, registry);
          return {
            blockId: block.blockId,
            confidence: 0.9,
            priority: Math.max(1, 10 - index),
            rationale:
              matchedTaskIds.length > 0
                ? `task-state marked ${matchedTaskIds.join(", ")} as evictable`
                : `task-state marked block ${block.blockId} as evictable`,
            estimatedSavedChars: block.charCount,
            parameters: {
              lifecycleSource: "task_state_registry",
              taskIds: matchedTaskIds,
              turnAbsIds: block.turnAbsIds ?? [],
              blockType: block.blockType,
              segmentIds: [...block.segmentIds],
              toolName: block.toolName,
              dataKey: block.dataKey,
              signalTypes: block.signalTypes ?? [],
            },
          };
        });

  return {
    enabled: true,
    policy: cfg.policy,
    blocks,
    instructions,
    estimatedSavedChars: instructions.reduce((sum, item) => sum + item.estimatedSavedChars, 0),
    notes: [
      "source=task_state_registry",
      `policy=${cfg.policy}`,
      `evictableTasks=${registry.evictableTaskIds.length}`,
      "eligibleBlockTypes=all_non_archived",
      `blocks=${blocks.length}`,
      `candidates=${candidates.length}`,
      `instructions=${instructions.length}`,
      `matchedTaskIds=${uniqueStrings(candidates.flatMap((block) => deriveBlockTaskIds(block, registry))).join(",") || "-"}`,
    ],
  };
}
