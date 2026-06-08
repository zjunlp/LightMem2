export type TranscriptSessionRow = {
  id?: string;
  parentId?: string;
  timestamp?: string;
  message: Record<string, unknown>;
};

export type StructuredTurnObservation = {
  id: string;
  role: "tool" | "observation";
  text: string;
  payloadKind?: "stdout" | "stderr" | "json" | "blob";
  toolName?: string;
  source: string;
  messageIndex?: number;
  mimeType?: string;
  textChars: number;
  textPreview: string;
  metadata?: Record<string, unknown>;
  recovery?: {
    source: string;
    skipReduction?: boolean;
  };
};

export type TranscriptHelpers = {
  contentToText: (value: unknown) => string;
  contextSafeRecovery: (details: unknown) => Record<string, unknown> | undefined;
  memoryFaultRecoverToolName: string;
};
