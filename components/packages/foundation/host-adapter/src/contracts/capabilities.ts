export type HostAdapterCapabilities = {
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsInstructionsField: boolean;
  supportsPromptCacheKey: boolean;
  supportsBeforeCallRewrite: boolean;
  supportsAfterCallObservation: boolean;
  supportsSynchronousToolInterception: boolean;
  supportsToolArgumentRewrite: boolean;
  supportsTranscriptRead: boolean;
  supportsTranscriptRewrite: boolean;
  supportsCommandRegistration: boolean;
  supportsNativeVisualization: boolean;
  supportsStableSessionIdentity: boolean;
  supportsStableTurnIdentity: boolean;
};

export const MINIMAL_HOST_CAPABILITIES: HostAdapterCapabilities = {
  supportsStreaming: false,
  supportsToolCalls: false,
  supportsInstructionsField: false,
  supportsPromptCacheKey: false,
  supportsBeforeCallRewrite: false,
  supportsAfterCallObservation: false,
  supportsSynchronousToolInterception: false,
  supportsToolArgumentRewrite: false,
  supportsTranscriptRead: false,
  supportsTranscriptRewrite: false,
  supportsCommandRegistration: false,
  supportsNativeVisualization: false,
  supportsStableSessionIdentity: false,
  supportsStableTurnIdentity: false,
};

export const REQUEST_RESPONSE_HOST_CAPABILITIES: HostAdapterCapabilities = {
  ...MINIMAL_HOST_CAPABILITIES,
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsInstructionsField: true,
  supportsBeforeCallRewrite: true,
  supportsAfterCallObservation: true,
  supportsStableSessionIdentity: true,
};

export function canSupportStablePrefix(
  capabilities: HostAdapterCapabilities,
): boolean {
  return capabilities.supportsBeforeCallRewrite;
}

export function canSupportReductionCore(
  capabilities: HostAdapterCapabilities,
): boolean {
  return capabilities.supportsBeforeCallRewrite
    || capabilities.supportsAfterCallObservation;
}

export function canSupportLifecycleEvictionEquivalently(
  capabilities: HostAdapterCapabilities,
): boolean {
  return capabilities.supportsTranscriptRead
    && capabilities.supportsTranscriptRewrite;
}

export function canSupportToolCallMemo(
  capabilities: HostAdapterCapabilities,
): boolean {
  return capabilities.supportsSynchronousToolInterception;
}
