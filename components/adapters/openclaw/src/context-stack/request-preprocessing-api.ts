export {
  estimatePayloadInputChars,
  extractInputText,
  findDeveloperAndPrimaryUser,
  normalizeText,
  normalizeTurnBindingMessage,
} from "./request-preprocessing/stable-prefix.js";
export {
  applyProxyReductionToInput,
  type ProxyReductionResult,
} from "./request-preprocessing/before-call-reduction.js";
export {
  applyLayeredReductionAfterCall,
  applyLayeredReductionAfterCallToSse,
  type AfterCallPassToggles,
  type ProxyAfterCallReductionResult,
} from "./request-preprocessing/after-call-reduction.js";
export {
  extractProxyResponseText,
  patchProxyResponseText,
} from "./request-preprocessing/after-call-response-text.js";
export {
  buildLayeredReductionContext,
  type BuildLayeredReductionContextResult,
  type ProxyReductionBinding,
  type ReductionContextPassToggles,
} from "./request-preprocessing/reduction-context.js";
export {
  loadOrderedTurnAnchors,
  loadSegmentAnchorByCallId,
} from "@lightmem2/history";
export {
  isReductionPassEnabled,
  type ReductionPassToggles,
} from "@tokenpilot/reduction";
export { applyToolResultPersistPolicy } from "./request-preprocessing/tool-results-persist-policy.js";
export {
  applyRootPromptRewriteToChatMessages,
  prependTextToContent,
  rewriteRootPromptForStablePrefix,
  type RootPromptRewrite,
} from "./request-preprocessing/root-prompt-stabilizer.js";
