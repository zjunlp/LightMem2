import {
  archiveContent,
  readArchive,
  resolveArchivePathAcrossSessions,
  resolveArchivePathFromLookup,
  type ArchiveContentParams,
  type ArchiveLocation,
  type GenericArchiveEntry,
} from "./archive-recovery/index.js";

export type ArtifactLookup = {
  dataKey: string;
  stateDir: string;
  sessionId?: string;
};

export interface ArtifactStore {
  archive(params: ArchiveContentParams): Promise<ArchiveLocation>;
  read(archivePath: string): Promise<GenericArchiveEntry | null>;
  resolve(lookup: ArtifactLookup): Promise<string | null>;
}

export function createFileSystemArtifactStore(): ArtifactStore {
  return {
    archive: archiveContent,
    read: readArchive,
    resolve: ({ dataKey, stateDir, sessionId }) =>
      sessionId
        ? resolveArchivePathFromLookup(dataKey, stateDir, sessionId)
        : resolveArchivePathAcrossSessions(dataKey, stateDir),
  };
}
