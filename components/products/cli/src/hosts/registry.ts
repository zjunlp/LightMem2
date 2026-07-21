import type { VisualHostSource } from "@tokenpilot/product-surface";
import { ProductHostRegistry, type ProductHostRegistration } from "@tokenpilot/product-surface";
import { CLAUDE_CODE_PRODUCT_HOST_REGISTRATION } from "../../../../adapters/claude-code/src/product-registration.js";
import { CODEX_PRODUCT_HOST_REGISTRATION } from "../../../../adapters/codex/src/product-registration.js";
import { OPENCLAW_PRODUCT_HOST_REGISTRATION } from "../../../../adapters/openclaw/src/product-registration.js";
import { readCliHostPathOverrides, type CliHostPathOverrides } from "../context-store.js";

export type CliHostRuntime = {
  handleCommand(ctx: { args: string; sessionId?: string }): Promise<{ text: string }>;
  maybeResolveLatestSessionId(): Promise<string | undefined>;
  resolveSessionId(sessionId?: string): Promise<string | undefined>;
};

export type CliHostRegistration = ProductHostRegistration & {
  createRuntime(target: {
    host: string;
    sessionId?: string;
    pathOverrides?: CliHostPathOverrides;
  }): CliHostRuntime;
};

export const CLI_HOSTS = [
  OPENCLAW_PRODUCT_HOST_REGISTRATION,
  CODEX_PRODUCT_HOST_REGISTRATION,
  CLAUDE_CODE_PRODUCT_HOST_REGISTRATION,
] as const;

export type CliHostId = (typeof CLI_HOSTS)[number]["hostId"];

const productHostRegistry = new ProductHostRegistry<ProductHostRegistration>(CLI_HOSTS);
let cliRuntimeRegistrations: Map<string, CliHostRegistration> | undefined;

export function registerCliHostProducts(registrations: readonly CliHostRegistration[]): void {
  const validated = new ProductHostRegistry(registrations);
  cliRuntimeRegistrations = new Map(
    validated.list().map((registration) => [registration.hostId, registration]),
  );
}

export function parseCliHostId(value: string | undefined): CliHostId | undefined {
  return productHostRegistry.parseHostId(value) as CliHostId | undefined;
}

async function productConfigPath(hostId: CliHostId): Promise<string | undefined> {
  const environmentPath = hostId === "codex"
    ? process.env.TOKENPILOT_CODEX_CONFIG?.trim()
    : hostId === "claude-code"
      ? process.env.TOKENPILOT_CLAUDE_CODE_CONFIG?.trim()
      : undefined;
  return environmentPath || (await readCliHostPathOverrides(hostId))?.tokenPilotConfigPath?.trim();
}

export async function resolveCliVisualHosts(): Promise<VisualHostSource[]> {
  const hosts: VisualHostSource[] = [];
  for (const definition of productHostRegistry.list()) {
    const stateDir = String((await definition.resolveStateDir({
      productConfigPath: await productConfigPath(definition.hostId as CliHostId),
    })) ?? "").trim();
    if (!stateDir) continue;
    hosts.push({
      hostId: definition.hostId,
      displayName: definition.displayName,
      stateDir,
    });
  }
  return hosts;
}

export async function resolveLatestCliReportHost(): Promise<{
  hostId: CliHostId;
  displayName: string;
  latestAt: string;
} | undefined> {
  let latestHost:
    | { hostId: CliHostId; displayName: string; latestAt: string; latestAtMs: number }
    | undefined;

  for (const definition of productHostRegistry.list()) {
    const hostId = definition.hostId as CliHostId;
    const stateDir = String((await definition.resolveStateDir({
      productConfigPath: await productConfigPath(hostId),
    })) ?? "").trim();
    if (!stateDir) continue;
    const latest = await definition.readLatestActivity(stateDir);
    const latestAt = typeof latest?.at === "string" ? latest.at.trim() : "";
    const latestAtMs = latestAt ? Date.parse(latestAt) : Number.NaN;
    if (!Number.isFinite(latestAtMs)) continue;
    if (!latestHost || latestAtMs > latestHost.latestAtMs) {
      latestHost = { hostId, displayName: definition.displayName, latestAt, latestAtMs };
    }
  }

  if (!latestHost) return undefined;
  return {
    hostId: latestHost.hostId,
    displayName: latestHost.displayName,
    latestAt: latestHost.latestAt,
  };
}

export function getCliHostRegistration(hostId: CliHostId): CliHostRegistration {
  const registration = cliRuntimeRegistrations?.get(hostId);
  if (!registration) throw new Error(`No CLI host registration for '${hostId}'`);
  return registration;
}
