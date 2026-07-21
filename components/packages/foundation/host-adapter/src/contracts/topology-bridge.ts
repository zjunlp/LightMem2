import type { HostSessionContext } from "../model/host-session.js";

export type HostTurnTopology = {
  session: HostSessionContext;
  turnId?: string;
  parentTurnId?: string;
  sequence?: number;
  metadata?: Record<string, unknown>;
};

export type HostTopologyBridge = {
  resolveTopology(
    session: HostSessionContext,
    rawPayload?: unknown,
  ): Promise<HostTurnTopology> | HostTurnTopology;
};
