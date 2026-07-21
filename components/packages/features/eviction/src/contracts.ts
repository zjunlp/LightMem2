import type { CanonicalTranscriptState } from "@lightmem2/history";

export type LifecyclePlanningResult = {
  enabled: boolean;
  executed: boolean;
  registryChanged?: boolean;
  planCreated?: boolean;
  plannedSavedChars?: number;
  plannedInstructionCount?: number;
  estimatorUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd?: number;
  };
  skippedReason?: "module_disabled" | "policy_module_unavailable";
  policyMetadata?: unknown;
};

export type HistoryEvictionResult = {
  state: CanonicalTranscriptState;
  enabled: boolean;
  changed: boolean;
  appliedTaskIds: string[];
  savedChars: number;
  diagnostics: {
    beforeMessageCount: number;
    afterMessageCount: number;
    beforeChars: number;
    afterChars: number;
    skippedReason?: "module_disabled";
  };
};
