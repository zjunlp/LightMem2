export type ReductionStrategy =
  | "read_state_compaction"
  | "exec_output_truncation"
  | "tool_payload_trim"
  | "html_slimming"
  | "format_slimming"
  | "semantic_compression"
  | "format_cleaning"
  | "path_truncation"
  | "image_downsample"
  | "line_number_strip"
  | "agents_startup_optimization"
  | (string & {});

export type ReductionInstruction = {
  strategy: ReductionStrategy;
  segmentIds: string[];
  confidence: number;
  priority: number;
  rationale: string;
  parameters?: Record<string, unknown>;
};

export type ReductionDecision = {
  enabled: boolean;
  instructions: ReductionInstruction[];
  estimatedSavedChars: number;
  notes?: string[];
};
