/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  rewriteCanonicalState as rewriteCanonicalStateBase,
  syncCanonicalStateFromTranscript,
  type CanonicalTranscriptState,
  type RewriteCanonicalStateParams,
} from "@lightmem2/history";
import { applyCanonicalEviction } from "./canonical-eviction.js";

export { syncCanonicalStateFromTranscript, type CanonicalTranscriptState };

export async function rewriteCanonicalState(
  params: Omit<RewriteCanonicalStateParams, "applyCanonicalEviction">,
): ReturnType<typeof rewriteCanonicalStateBase> {
  return rewriteCanonicalStateBase({
    ...params,
    applyCanonicalEviction,
  });
}
