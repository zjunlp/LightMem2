import type { HostIdentity } from "../model/host-session.js";

export type StateRoots = {
  stateDir: string;
  namespaceDir: string;
  workspaceArchiveDirname?: string;
};

export type StatePathResolver = {
  host: HostIdentity;
  roots: StateRoots;
  defaultStateDir(): string;
  stateDirCandidates(explicitStateDir?: string): string[];
};

export function createStaticStatePathResolver(params: {
  hostId: string;
  displayName: string;
  stateDir: string;
  namespaceDir: string;
  workspaceArchiveDirname?: string;
}): StatePathResolver {
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
