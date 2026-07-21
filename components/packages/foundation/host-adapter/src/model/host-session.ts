export type HostIdentity = {
  hostId: string;
  displayName: string;
};

export type HostSessionMode = "single" | "cross";

export type HostSessionContext = {
  host: HostIdentity;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  sessionMode: HostSessionMode;
  metadata?: Record<string, unknown>;
};
