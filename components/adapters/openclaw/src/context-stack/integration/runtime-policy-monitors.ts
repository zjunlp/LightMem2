/* eslint-disable @typescript-eslint/no-explicit-any */

function logTaskStateMonitor(
  ctx: any,
  logger: { info: (message: string) => void },
  asRecord: (value: unknown) => Record<string, unknown> | undefined,
): void {
  const taskState = asRecord(asRecord(asRecord(ctx.metadata?.policy)?.decisions)?.taskState);
  if (!taskState || taskState.enabled !== true || taskState.attempted !== true) return;

  const transitions = Array.isArray(taskState.transitions)
    ? taskState.transitions
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const rejected = Array.isArray(taskState.rejectedUpdates)
    ? taskState.rejectedUpdates
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const touchedTaskIds = Array.isArray(taskState.touchedTaskIds)
    ? taskState.touchedTaskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const note = typeof taskState.note === "string" ? taskState.note.trim() : "";

  if (transitions.length === 0 && rejected.length === 0 && !note) return;

  const transitionText =
    transitions.length > 0
      ? transitions
          .slice(0, 8)
          .map((item) => {
            const taskId = typeof item.taskId === "string" ? item.taskId : "task";
            const from = typeof item.from === "string" && item.from.trim().length > 0 ? item.from : "new";
            const to = typeof item.to === "string" ? item.to : "unknown";
            return `${taskId}:${from}->${to}`;
          })
          .join(", ")
      : "none";
  const rejectedText =
    rejected.length > 0
      ? rejected
          .slice(0, 8)
          .map((item) => {
            const taskId = typeof item.taskId === "string" ? item.taskId : "task";
            const from = typeof item.from === "string" && item.from.trim().length > 0 ? item.from : "new";
            const to = typeof item.to === "string" ? item.to : "unknown";
            const reason = typeof item.reason === "string" ? item.reason : "rejected";
            return `${taskId}:${from}->${to}(${reason})`;
          })
          .join(", ")
      : "none";
  logger.info(
    `[plugin-runtime/task-state] session=${ctx.sessionId} applied=${taskState.applied === true} touched=${touchedTaskIds.length} transitions=[${transitionText}] rejected=[${rejectedText}]${note ? ` note=${note}` : ""}`,
  );
}

function logEvictionPlanMonitor(
  ctx: any,
  logger: { info: (message: string) => void },
  asRecord: (value: unknown) => Record<string, unknown> | undefined,
): void {
  const eviction = asRecord(asRecord(asRecord(ctx.metadata?.policy)?.decisions)?.eviction);
  if (!eviction || eviction.enabled !== true) return;
  const instructions = Array.isArray(eviction.instructions)
    ? eviction.instructions
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  if (instructions.length === 0) return;
  const taskIds = Array.from(
    new Set(
      instructions.flatMap((item) => {
        const params = asRecord(item.parameters);
        const taskId =
          typeof params?.taskId === "string" && params.taskId.trim().length > 0 ? [params.taskId.trim()] : [];
        return taskId;
      }),
    ),
  );
  logger.info(
    `[plugin-runtime/eviction-plan] session=${ctx.sessionId} instructions=${instructions.length} tasks=${taskIds.length > 0 ? taskIds.join(", ") : "unknown"} policy=${typeof eviction.policy === "string" ? eviction.policy : "unknown"}`,
  );
}

export function applyPolicyMonitors(
  ctx: any,
  logger: { info: (message: string) => void },
  asRecord: (value: unknown) => Record<string, unknown> | undefined,
): void {
  logTaskStateMonitor(ctx, logger, asRecord);
  logEvictionPlanMonitor(ctx, logger, asRecord);
}
