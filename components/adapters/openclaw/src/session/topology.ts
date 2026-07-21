export type SessionTopologyManager = {
  bindUpstreamSession(sessionKey: string, upstreamSessionId?: string): void;
  getUpstreamSessionId(sessionKey: string): string | null;
  getLatestUpstreamSessionId(): string | null;
};

export function createSessionTopologyManager(): SessionTopologyManager {
  const upstreamSessionIdBySessionKey = new Map<string, string>();
  let latestUpstreamSessionId: string | null = null;

  return {
    bindUpstreamSession(sessionKey: string, upstreamSessionId?: string): void {
      const normalizedSessionKey = String(sessionKey ?? "").trim();
      const normalizedUpstreamSessionId = String(upstreamSessionId ?? "").trim();
      if (!normalizedSessionKey || !normalizedUpstreamSessionId) return;
      upstreamSessionIdBySessionKey.set(normalizedSessionKey, normalizedUpstreamSessionId);
      latestUpstreamSessionId = normalizedUpstreamSessionId;
    },
    getUpstreamSessionId(sessionKey: string): string | null {
      const normalizedSessionKey = String(sessionKey ?? "").trim();
      if (!normalizedSessionKey) return null;
      return upstreamSessionIdBySessionKey.get(normalizedSessionKey) ?? null;
    },
    getLatestUpstreamSessionId(): string | null {
      return latestUpstreamSessionId;
    },
  };
}
