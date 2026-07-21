/* eslint-disable @typescript-eslint/no-explicit-any */

type RegistryLike = {
  turnToTaskIds: Record<string, string[]>;
};

export function sortedRegistryTurnAnchors(
  registry: RegistryLike,
  dedupeStrings: (values: string[]) => string[],
): Array<{ turnAbsId: string; taskIds: string[] }> {
  return Object.entries(registry.turnToTaskIds)
    .map(([turnAbsId, taskIds]) => ({
      turnAbsId,
      taskIds: dedupeStrings(taskIds),
      turnSeq: Number(turnAbsId.split(":t").at(-1) ?? Number.NaN),
    }))
    .filter((item) => item.turnAbsId.trim().length > 0 && Number.isFinite(item.turnSeq))
    .sort((a, b) => a.turnSeq - b.turnSeq)
    .map(({ turnAbsId, taskIds }) => ({ turnAbsId, taskIds }));
}

export function annotateCanonicalMessagesWithTaskAnchors(
  messages: any[],
  registry: RegistryLike,
  asRecord: (value: unknown) => Record<string, unknown> | undefined,
  dedupeStrings: (values: string[]) => string[],
  ensureContextSafeDetails: (
    details: unknown,
    patch: Record<string, unknown>,
  ) => Record<string, unknown>,
): { messages: any[]; changed: boolean } {
  const anchors = sortedRegistryTurnAnchors(registry, dedupeStrings);
  if (anchors.length === 0) return { messages, changed: false };
  const anchorIndexByTurnAbsId = new Map(anchors.map((anchor, index) => [anchor.turnAbsId, index] as const));
  let currentIndex = -1;
  let currentAnchor = anchors[0];
  let changed = false;
  const nextMessages = messages.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const message = raw as Record<string, unknown>;
    const details = asRecord(message.details);
    const contextSafe = asRecord(details?.contextSafe);
    const existingEviction = asRecord(contextSafe?.eviction);
    if (existingEviction?.archived === true || existingEviction?.kind === "cached_pointer_stub") {
      return raw;
    }
    const prevTurnAbsId = typeof contextSafe?.turnAbsId === "string" ? contextSafe.turnAbsId : "";
    const prevTaskIds = Array.isArray(contextSafe?.taskIds)
      ? contextSafe.taskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const anchoredIndex = prevTurnAbsId ? anchorIndexByTurnAbsId.get(prevTurnAbsId) : undefined;
    if (anchoredIndex !== undefined) {
      currentIndex = anchoredIndex;
      currentAnchor = anchors[anchoredIndex]!;
      const expectedTaskIds = currentAnchor?.taskIds ?? [];
      if (JSON.stringify(prevTaskIds) === JSON.stringify(expectedTaskIds)) {
        return raw;
      }
    }
    const role = String(message.role ?? "").toLowerCase();
    if (role === "user" && currentIndex + 1 < anchors.length) {
      currentIndex += 1;
      currentAnchor = anchors[currentIndex]!;
    } else if (currentIndex < 0) {
      currentIndex = 0;
      currentAnchor = anchors[0]!;
    }
    const nextTaskIds = currentAnchor?.taskIds ?? [];
    if (prevTurnAbsId === currentAnchor.turnAbsId && JSON.stringify(prevTaskIds) === JSON.stringify(nextTaskIds)) {
      return raw;
    }
    changed = true;
    return {
      ...message,
      details: ensureContextSafeDetails(message.details, {
        turnAbsId: currentAnchor.turnAbsId,
        taskIds: nextTaskIds,
      }),
    };
  });
  return { messages: nextMessages, changed };
}
