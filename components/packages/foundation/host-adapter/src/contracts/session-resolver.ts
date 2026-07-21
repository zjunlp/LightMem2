import type { HostSessionContext } from "../model/host-session.js";

export type HostSessionResolver = {
  resolve(
    headers?: Record<string, string | string[] | undefined>,
    rawPayload?: unknown,
  ): HostSessionContext;
};
