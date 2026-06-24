import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { TokenPilotCodexConfig } from "./config.js";
import { readCodexProviderFromToml } from "./config.js";
import { readDaemonStatus } from "./daemon.js";

export type CodexDoctorReport = {
  configPath: string;
  hooksConfigPath: string;
  tokenPilotConfigPath: string;
  proxyBaseUrl: string;
  providerInstalled: boolean;
  hooksInstalled: boolean;
  daemonRunning: boolean;
  proxyHealthy: boolean;
  stateDir: string;
  upstreamProvider?: string;
};

async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

export function formatCodexDoctorReport(report: CodexDoctorReport): string {
  return [
    "TokenPilot Codex doctor:",
    `- tokenpilot config: ${report.tokenPilotConfigPath}`,
    `- codex config: ${report.configPath}`,
    `- hooks config: ${report.hooksConfigPath}`,
    `- stateDir: ${report.stateDir}`,
    `- provider installed: ${report.providerInstalled ? "yes" : "no"}`,
    `- hooks installed: ${report.hooksInstalled ? "yes" : "no"}`,
    `- daemon running: ${report.daemonRunning ? "yes" : "no"}`,
    `- proxy healthy: ${report.proxyHealthy ? "yes" : "no"}`,
    `- proxy base URL: ${report.proxyBaseUrl}`,
    `- upstream provider: ${report.upstreamProvider ?? "(unset)"}`,
  ].join("\n");
}

export async function inspectCodexDoctor(params: {
  config: TokenPilotCodexConfig;
  configPath: string;
  tokenPilotConfigPath: string;
  hooksConfigPath: string;
}): Promise<CodexDoctorReport> {
  const daemon = await readDaemonStatus(params.config);
  const proxyBaseUrl = `http://127.0.0.1:${params.config.proxyPort}/v1`;
  const providerName = params.config.providerName || "tokenpilot";
  const tokenpilotProvider = await readCodexProviderFromToml(providerName, params.configPath);
  const hooksText = existsSync(params.hooksConfigPath)
    ? await readFile(params.hooksConfigPath, "utf8").catch(() => "")
    : "";
  const hooksInstalled = hooksText.includes("tokenpilot-codex") || hooksText.includes("hooks-handler.js");
  return {
    configPath: params.configPath,
    hooksConfigPath: params.hooksConfigPath,
    tokenPilotConfigPath: params.tokenPilotConfigPath,
    proxyBaseUrl,
    providerInstalled: Boolean(tokenpilotProvider),
    hooksInstalled,
    daemonRunning: daemon.running,
    proxyHealthy: await checkHealth(proxyBaseUrl),
    stateDir: params.config.stateDir,
    upstreamProvider: params.config.upstreamProvider,
  };
}
