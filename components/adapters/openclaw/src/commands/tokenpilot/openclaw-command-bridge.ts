import type { TokenPilotProductSurfaceHostBridge } from "@lightmem2/host-adapter";
import { handleVisual } from "./session-visual.js";
import { formatOpenClawDoctorReport, inspectOpenClawDoctor } from "./openclaw-doctor.js";
import { handleReport } from "./session-report.js";

export function createOpenClawProductSurfaceBridge(api: any): TokenPilotProductSurfaceHostBridge {
  return {
    loadConfig: () => api.runtime.config.loadConfig() as Record<string, unknown>,
    writeConfig: (nextConfig) => api.runtime.config.writeConfigFile(nextConfig),
    handleReport: (ctx, currentConfig) => handleReport(ctx, currentConfig),
    handleDoctor: (currentConfig) => ({
      text: formatOpenClawDoctorReport(inspectOpenClawDoctor(currentConfig)),
    }),
    handleVisual: (currentConfig) => handleVisual(currentConfig),
  };
}
