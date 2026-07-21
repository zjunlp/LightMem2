/* eslint-disable @typescript-eslint/no-explicit-any */
export function createWorkspaceHintStore(
  extractSessionKey: (event: any) => string | undefined,
  extractOpenClawSessionId: (event: any) => string | undefined,
): {
  rememberWorkspaceHint: (
    sessionKey: string | undefined,
    sessionId: string | undefined,
    workspaceDir: string | undefined,
  ) => void;
  resolveWorkspaceHintForEvent: (event: any) => string | undefined;
} {
  const workspaceDirBySessionKey = new Map<string, string>();
  const workspaceDirBySessionId = new Map<string, string>();

  const rememberWorkspaceHint = (
    sessionKey: string | undefined,
    sessionId: string | undefined,
    workspaceDir: string | undefined,
  ) => {
    const normalizedWorkspaceDir = typeof workspaceDir === "string" ? workspaceDir.trim() : "";
    if (!normalizedWorkspaceDir) return;
    const normalizedSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (normalizedSessionKey) workspaceDirBySessionKey.set(normalizedSessionKey, normalizedWorkspaceDir);
    if (normalizedSessionId) workspaceDirBySessionId.set(normalizedSessionId, normalizedWorkspaceDir);
  };

  const resolveWorkspaceHintForEvent = (event: any): string | undefined => {
    const sessionKey = extractSessionKey(event);
    const sessionId = extractOpenClawSessionId(event);
    return (
      (sessionKey ? workspaceDirBySessionKey.get(sessionKey) : undefined)
      ?? (sessionId ? workspaceDirBySessionId.get(sessionId) : undefined)
      ?? undefined
    );
  };

  return {
    rememberWorkspaceHint,
    resolveWorkspaceHintForEvent,
  };
}
