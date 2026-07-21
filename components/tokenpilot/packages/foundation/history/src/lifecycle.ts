import type {
  HistoryBlock,
  HistoryLifecycleConfig,
  HistoryLifecycleDerivationResult,
  HistorySignal,
  HistorySignalType,
  HistoryTransitionEvidence,
} from "./types.js";

const DEFAULT_COMPACTABLE_SIGNAL_CONFIDENCE_MIN = 0.75;

const COMPACTABLE_SIGNALS = new Set<HistorySignalType>([
  "READ_CONSUMED_BY_WRITE",
  "REPEATED_READ",
  "FAILED_TOOL_PATH",
]);

function bucketSignals(signals: HistorySignal[]): Map<string, HistorySignal[]> {
  const out = new Map<string, HistorySignal[]>();
  for (const signal of signals) {
    const existing = out.get(signal.blockId) ?? [];
    existing.push(signal);
    out.set(signal.blockId, existing);
  }
  return out;
}

function uniqueSignalTypes(signals: HistorySignal[]): HistorySignalType[] {
  return [...new Set(signals.map((signal) => signal.type))];
}

function deriveConsumedByBlockIds(signals: HistorySignal[]): string[] {
  const ids = new Set<string>();
  for (const signal of signals) {
    const consumedBy = signal.metadata?.consumedByBlockId;
    if (typeof consumedBy === "string" && consumedBy.trim().length > 0) ids.add(consumedBy);
  }
  return [...ids];
}

function transition(
  fromState: HistoryBlock["lifecycleState"],
  toState: HistoryBlock["lifecycleState"],
  reason: string,
  signals: HistorySignal[],
): HistoryTransitionEvidence[] {
  if (fromState === toState) return [];
  return [{
    fromState,
    toState,
    reason,
    signalTypes: uniqueSignalTypes(signals),
  }];
}

export function deriveHistoryLifecycle(
  blocks: HistoryBlock[],
  signals: HistorySignal[],
  config: HistoryLifecycleConfig = {},
): HistoryLifecycleDerivationResult {
  const minConfidence = Math.max(
    0,
    Math.min(1, config.compactableSignalConfidenceMin ?? DEFAULT_COMPACTABLE_SIGNAL_CONFIDENCE_MIN),
  );
  const blockSignals = bucketSignals(signals);

  const nextBlocks = blocks.map((block) => {
    const attachedSignals = blockSignals.get(block.blockId) ?? [];
    const signalTypes = uniqueSignalTypes(attachedSignals);
    const consumedByBlockIds = deriveConsumedByBlockIds(attachedSignals);
    const fromState = block.lifecycleState;
    let lifecycleState = fromState;
    let reason = "";

    if (block.blockType === "summary_seed" || block.blockType === "pointer_stub") {
      lifecycleState = signalTypes.includes("RECENT_BLOCK") ? "COMPACTED" : "EVICTABLE";
      reason = lifecycleState === "EVICTABLE"
        ? "pre-compacted block is outside recent window"
        : "pre-compacted block kept active because it is still recent";
    } else {
      const compactableSignals = attachedSignals.filter(
        (signal) => COMPACTABLE_SIGNALS.has(signal.type) && signal.confidence >= minConfidence,
      );
      if (compactableSignals.length > 0) {
        lifecycleState = "COMPACTABLE";
        reason = compactableSignals
          .map((signal) => signal.rationale)
          .join("; ");
      }
    }

    return {
      ...block,
      lifecycleState,
      signals: attachedSignals,
      signalTypes,
      consumedByBlockIds,
      transitionEvidence: transition(fromState, lifecycleState, reason, attachedSignals),
    };
  });

  return {
    blocks: nextBlocks,
    blockSignals,
  };
}
