import type { TokenPilotHostIdentity } from "../model/host-session.js";

export type TokenPilotStateRoots = {
  stateDir: string;
  namespaceDir: string;
  workspaceArchiveDirname?: string;
};

export type TokenPilotStatePathResolver = {
  host: TokenPilotHostIdentity;
  roots: TokenPilotStateRoots;
  defaultStateDir(): string;
  stateDirCandidates(explicitStateDir?: string): string[];
};

export function createStaticStatePathResolver(params: {
  hostId: string;
  displayName: string;
  stateDir: string;
  namespaceDir: string;
  workspaceArchiveDirname?: string;
}): TokenPilotStatePathResolver {
  const stateDir = params.stateDir.trim();
  const namespaceDir = params.namespaceDir.trim();
  return {
    host: {
      hostId: params.hostId,
      displayName: params.displayName,
    },
    roots: {
      stateDir,
      namespaceDir,
      workspaceArchiveDirname: params.workspaceArchiveDirname,
    },
    defaultStateDir() {
      return stateDir;
    },
    stateDirCandidates(explicitStateDir?: string) {
      if (explicitStateDir && explicitStateDir.trim().length > 0) {
        return [explicitStateDir.trim()];
      }
      return [stateDir];
    },
  };
}
