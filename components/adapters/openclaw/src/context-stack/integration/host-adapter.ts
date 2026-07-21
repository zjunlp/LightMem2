import { createStaticStatePathResolver } from "@lightmem2/host-adapter";
import {
  resolveDefaultOpenClawTokenPilotStateDir,
  resolveOpenClawTokenPilotStateDirCandidates,
} from "./openclaw-paths.js";

export function createOpenClawStatePathResolver() {
  const defaultStateDir = resolveDefaultOpenClawTokenPilotStateDir();

  const resolver = createStaticStatePathResolver({
    hostId: "openclaw",
    displayName: "OpenClaw",
    stateDir: defaultStateDir,
    namespaceDir: "tokenpilot",
    workspaceArchiveDirname: ".tokenpilot-archives",
  });

  return {
    ...resolver,
    defaultStateDir() {
      return resolveDefaultOpenClawTokenPilotStateDir();
    },
    stateDirCandidates(explicitStateDir?: string) {
      return resolveOpenClawTokenPilotStateDirCandidates(explicitStateDir);
    },
  };
}
