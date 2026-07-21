export type StreamObservation = {
  streamObserved: boolean;
  assistantTextChars?: number;
  usage?: Record<string, unknown>;
};

export function buildStreamObservation(params?: {
  assistantText?: string;
  usage?: Record<string, unknown>;
}): StreamObservation {
  return {
    streamObserved: true,
    assistantTextChars: typeof params?.assistantText === "string" ? params.assistantText.length : undefined,
    usage: params?.usage,
  };
}
