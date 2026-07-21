export type TokenPilotHostIdentity = {
  hostId: string;
  displayName: string;
};

export type HostSessionMode = "single" | "cross";

export type HostSessionContext = {
  host: TokenPilotHostIdentity;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  sessionMode: HostSessionMode;
  metadata?: Record<string, unknown>;
};
