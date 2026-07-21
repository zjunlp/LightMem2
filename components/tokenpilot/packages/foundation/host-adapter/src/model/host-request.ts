import type { HostMessage } from "./host-message.js";
import type { HostSessionContext } from "./host-session.js";

export type HostRequestEnvelope = {
  session: HostSessionContext;
  model: string;
  stream: boolean;
  instructions?: string;
  messages: HostMessage[];
  tools?: unknown[];
  rawPayload: unknown;
  metadata?: Record<string, unknown>;
};
