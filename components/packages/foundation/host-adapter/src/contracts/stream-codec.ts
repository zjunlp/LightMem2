export type HostStreamCodec = {
  collectAssistantText(rawStreamText: string): string;
  extractUsage?(rawStreamText: string): Record<string, unknown> | undefined;
  patchAssistantText?(rawStreamText: string, nextText: string): string;
};

export type HostStreamSnapshot = {
  assistantText: string;
  usage?: Record<string, unknown>;
  promptCacheKey?: string;
  rawStreamText: string;
};
