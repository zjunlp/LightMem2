import { defineProductRegistration } from "@lightmem2/product-surface";
import {
  TOKENPILOT_PRESET_ID,
  TOKENPILOT_PRESET_VERSION,
} from "@lightmem2/tokenpilot";

export const TOKENPILOT_RECOVERY_MCP_PRODUCT = defineProductRegistration({
  productId: "tokenpilot-memory-fault-recover",
  displayName: "TokenPilot Memory Fault Recovery MCP",
  kind: "mcp",
  preset: {
    presetId: TOKENPILOT_PRESET_ID,
    presetVersion: TOKENPILOT_PRESET_VERSION,
  },
});
