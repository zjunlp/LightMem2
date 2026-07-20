/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  applyCanonicalEviction as applyCanonicalEvictionBase,
  computeClosureDeferredTaskInfo,
  type EvictionHelpers,
} from "@tokenpilot/history";
import { pluginStateSubdir } from "@tokenpilot/artifact-store";

export { computeClosureDeferredTaskInfo, type EvictionHelpers };

export async function applyCanonicalEviction(
  params: Omit<Parameters<typeof applyCanonicalEvictionBase>[0], "archiveDir" | "persistedBy" | "archiveSourceLabel">,
): ReturnType<typeof applyCanonicalEvictionBase> {
  return applyCanonicalEvictionBase({
    ...params,
    archiveDir: pluginStateSubdir(params.stateDir, "canonical-eviction", "task"),
    persistedBy: "runtime.context_engine.eviction",
    archiveSourceLabel: "canonical_task_eviction",
  });
}
