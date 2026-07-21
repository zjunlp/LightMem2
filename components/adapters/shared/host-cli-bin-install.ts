import { chmod, mkdir, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CliHostId } from "../../products/cli/src/hosts/registry.js";

function hostCliDistPathFromAdapterRoot(adapterRoot: string): string {
  return resolve(adapterRoot, "dist", "cli.js");
}

function hostCliBinName(host: CliHostId): string {
  if (host === "codex") return "tokenpilot-codex";
  if (host === "claude-code") return "tokenpilot-claude-code";
  throw new Error(`unsupported host CLI bin install: ${host}`);
}

export async function installHostCliBin(params: {
  adapterRoot: string;
  host: "codex" | "claude-code";
  binDir: string;
}): Promise<{
  installed: boolean;
  binPath: string;
  binName: string;
  cliDistPath: string;
}> {
  const binName = hostCliBinName(params.host);
  const cliDistPath = hostCliDistPathFromAdapterRoot(params.adapterRoot);
  const binPath = join(params.binDir, binName);

  await mkdir(dirname(binPath), { recursive: true });
  await chmod(cliDistPath, 0o755).catch(() => undefined);
  await unlink(binPath).catch(() => undefined);
  await symlink(cliDistPath, binPath);
  await chmod(binPath, 0o755).catch(() => undefined);

  return {
    installed: true,
    binPath,
    binName,
    cliDistPath,
  };
}
