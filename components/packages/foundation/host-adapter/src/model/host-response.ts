import type { HostToolCall } from "./host-message.js";

export type HostResponseEnvelope = {
  assistantText?: string;
  toolCalls?: HostToolCall[];
  usage?: Record<string, unknown>;
  rawResponse: unknown;
  metadata?: Record<string, unknown>;
};
