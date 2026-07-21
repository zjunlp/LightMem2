import type { HostSessionContext } from "../model/host-session.js";

export type HostTraceEvent = {
  kind:
    | "session_start"
    | "request_start"
    | "request_end"
    | "tool_start"
    | "tool_end"
    | "response_end"
    | "custom";
  session: HostSessionContext;
  toolName?: string;
  payload?: Record<string, unknown>;
  timestampMs?: number;
};

export type HostTraceBridge = {
  appendTrace(
    event: HostTraceEvent,
  ): Promise<void> | void;
};
