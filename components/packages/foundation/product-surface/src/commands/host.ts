import { splitArgs } from "../config.js";
import { formatProductHelp, summarizeProductStatus } from "../presentation.js";
import type { ProductSurfaceActionHandler, ProductSurfaceCommandDeps } from "./shared.js";
import { asTextResult } from "./shared.js";

function handleHelp(identity: ProductSurfaceCommandDeps["identity"], rest: string) {
  const section = splitArgs(rest)[0]?.toLowerCase();
  return asTextResult(formatProductHelp(identity, section), {
    kind: "text",
    data: section ? { section } : {},
  });
}

export function createHostActionHandlers(params: ProductSurfaceCommandDeps): Record<string, ProductSurfaceActionHandler> {
  const { bridge, configAdapter, identity } = params;

  return {
    help: (_ctx, _currentConfig, rest) => handleHelp(identity, rest),
    status: (_ctx, currentConfig) => asTextResult(
      summarizeProductStatus(currentConfig, configAdapter, identity),
      { kind: "status", data: { config: currentConfig } },
    ),
    report: async (ctx, currentConfig) => {
      if (bridge.handleReport) {
        return bridge.handleReport(ctx, currentConfig);
      }
      if (bridge.buildReportPayload) {
        const payload = await bridge.buildReportPayload(ctx, currentConfig);
        return asTextResult(formatProductHelp(identity), payload);
      }
      return asTextResult(formatProductHelp(identity), { kind: "report" });
    },
    doctor: async (_ctx, currentConfig) => {
      if (bridge.handleDoctor) {
        return bridge.handleDoctor(currentConfig);
      }
      if (bridge.buildDoctorPayload) {
        const payload = await bridge.buildDoctorPayload(currentConfig);
        return asTextResult(formatProductHelp(identity), payload);
      }
      return asTextResult(formatProductHelp(identity), { kind: "doctor" });
    },
    visual: async (_ctx, currentConfig) => {
      if (bridge.handleVisual) {
        return bridge.handleVisual(currentConfig);
      }
      if (bridge.buildVisualPayload) {
        const payload = await bridge.buildVisualPayload(currentConfig);
        return asTextResult(formatProductHelp(identity), payload);
      }
      return asTextResult(formatProductHelp(identity), { kind: "visual" });
    },
  };
}
