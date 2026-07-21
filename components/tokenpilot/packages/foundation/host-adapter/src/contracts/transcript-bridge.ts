import type { HostMessage } from "../model/host-message.js";
import type { HostSessionContext } from "../model/host-session.js";

export type HostTranscriptSnapshot = {
  session: HostSessionContext;
  messages: HostMessage[];
  source: "host" | "request-derived" | "trace-derived" | "unknown";
  metadata?: Record<string, unknown>;
};

export type HostTranscriptWriteMode =
  | "canonical"
  | "request-scoped"
  | "external-only";

export type HostTranscriptReadResult = {
  snapshot: HostTranscriptSnapshot | null;
  complete: boolean;
};

export type HostTranscriptBridge = {
  readTranscript(
    session: HostSessionContext,
  ): Promise<HostTranscriptReadResult> | HostTranscriptReadResult;
  writeTranscript?(
    session: HostSessionContext,
    snapshot: HostTranscriptSnapshot,
    mode?: HostTranscriptWriteMode,
  ): Promise<void> | void;
};
