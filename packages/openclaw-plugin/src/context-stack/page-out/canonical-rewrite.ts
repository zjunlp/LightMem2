/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  rewriteCanonicalState as rewriteCanonicalStateBase,
  syncCanonicalStateFromTranscript,
  type EcoCanonicalState,
  type RewriteCanonicalStateParams,
} from "@ecoclaw/layer-history";
import { applyCanonicalEviction } from "./canonical-eviction.js";

export { syncCanonicalStateFromTranscript, type EcoCanonicalState };

export async function rewriteCanonicalState(
  params: Omit<RewriteCanonicalStateParams, "applyCanonicalEviction">,
): ReturnType<typeof rewriteCanonicalStateBase> {
  return rewriteCanonicalStateBase({
    ...params,
    applyCanonicalEviction,
  });
}
